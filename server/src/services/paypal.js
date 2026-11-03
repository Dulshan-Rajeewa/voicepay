import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

const TOKEN_REFRESH_BUFFER_MS = 60_000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CURRENCY_PATTERN = /^[A-Z]{3}$/
const MAX_TRANSACTION_LIMIT = 500

let accessTokenCache = null
const mockOrders = new Map()
const transactionLogPath =
  config.transactionLogPath ||
  fileURLToPath(new URL('../../data/transactions.json', import.meta.url))
const legacyTransactionLogPath = fileURLToPath(
  new URL('../data/transactions.json', import.meta.url),
)

function assertAmount(amount, label = 'Amount') {
  const numericAmount = Number(amount)

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount <= 0 ||
    Math.abs(numericAmount * 100 - Math.round(numericAmount * 100)) > 1e-9
  ) {
    throw new Error(`${label} must be a positive amount with at most two decimals.`)
  }

  if (numericAmount > config.maxPaymentUsd) {
    throw new Error(
      `${label} cannot be greater than ${config.maxPaymentUsd.toFixed(2)} USD.`,
    )
  }

  return numericAmount.toFixed(2)
}

function assertCurrency(currency) {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new Error('Currency must be a three-letter uppercase code.')
  }

  return currency
}

function assertEmail(email) {
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
    throw new Error('Recipient email must be a valid email address.')
  }

  return email.trim()
}

function getErrorMessage(payload, status) {
  if (payload?.details?.[0]?.description) {
    return payload.details[0].description
  }

  if (payload?.message) {
    return payload.message
  }

  if (status === 401) {
    return 'PayPal authentication failed. Check the sandbox credentials.'
  }

  if (status === 403) {
    return 'PayPal denied this request. Check that the required sandbox capability is enabled.'
  }

  return 'PayPal could not complete the request. Please try again.'
}

async function paypalRequest(path, options = {}) {
  const token = await getAccessToken()
  let response

  try {
    response = await fetch(`${config.paypalBaseUrl}${path}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    })
  } catch {
    throw new Error('PayPal is unavailable right now. Please try again later.')
  }

  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, response.status))
  }

  return payload
}

async function readLocalTransactions() {
  try {
    const contents = await readFile(transactionLogPath, 'utf8')
    const entries = JSON.parse(contents)
    return Array.isArray(entries) ? entries : []
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error('The local transaction log could not be read.')
    }

    if (transactionLogPath === legacyTransactionLogPath) return []

    try {
      const contents = await readFile(legacyTransactionLogPath, 'utf8')
      const entries = JSON.parse(contents)
      return Array.isArray(entries) ? entries : []
    } catch (legacyError) {
      if (legacyError.code === 'ENOENT') return []
      throw new Error('The local transaction log could not be read.')
    }
  }
}

async function writeLocalTransactions(entries) {
  await mkdir(path.dirname(transactionLogPath), { recursive: true })
  await writeFile(transactionLogPath, `${JSON.stringify(entries, null, 2)}\n`)
}

function mapPayoutStatus(status) {
  const normalized = String(status || '').toUpperCase()
  if (normalized === 'SUCCESS' || normalized === 'COMPLETED') return 'COMPLETED'
  if (normalized === 'DENIED' || normalized === 'CANCELED' || normalized === 'UNCLAIMED') return 'DENIED'
  if (normalized === 'FAILED') return 'FAILED'
  return 'PENDING'
}

function mapReportingStatus(status) {
  return {
    S: 'COMPLETED',
    P: 'PENDING',
    D: 'DENIED',
    F: 'FAILED',
    V: 'DENIED',
  }[String(status || '').toUpperCase()] || 'PENDING'
}

function getTransactionAmount(transaction) {
  return Number(
    transaction.transaction_info?.transaction_amount?.value ??
      transaction.amount?.value ??
      0,
  )
}

function getTransactionFee(transaction, fallback = 0) {
  const fee = Number(transaction.transaction_info?.fee_amount?.value)
  return Number.isFinite(fee) ? Math.abs(fee) : fallback
}

function getEndingBalance(transaction) {
  return transaction.transaction_info?.ending_balance?.value ??
    transaction.transaction_info?.available_balance?.value ??
    null
}

function hasSystemFundingContext(transaction) {
    const info = transaction.transaction_info || {}
    const payer = JSON.stringify(transaction.payer_info || info.payer_info || '').toLowerCase()
    const subject = String(info.transaction_subject || '').toLowerCase()
    const merchant = transaction.payee_info || info.payee_info || info.merchant_info
    const looksLikeFunding =
      payer.includes('paypal') ||
      subject.includes('initial balance') ||
      subject.includes('funding') ||
      subject.includes('deposit')

    return looksLikeFunding && !merchant && !info.transaction_subject?.match(/payment to|purchase/i)
  }

function hasUserPaymentContext(transaction) {
    const info = transaction.transaction_info || {}
    const subject = String(info.transaction_subject || '').toLowerCase()
    const eventCode = String(info.transaction_event_code || '').toUpperCase()
    const recipient = JSON.stringify(
      transaction.payee_info ||
        transaction.receiver_info ||
        info.payee_info ||
        info.receiver_info ||
        '',
    ).toLowerCase()

    return (
      /payment to|purchase|payout|sent to/.test(subject) ||
      /payment to|purchase|payout|sent to/.test(recipient) ||
      ['T0003', 'T0004', 'T0005', 'T0006'].includes(eventCode)
    )
  }

function normalizeReportedTransaction(transaction) {
  const status = mapReportingStatus(transaction.transaction_info?.transaction_status)
  const isPayout = hasUserPaymentContext(transaction)
  return {
    ...transaction,
    fee: getTransactionFee(transaction, isPayout ? 0.25 : 0),
    endingBalance: getEndingBalance(transaction),
    transaction_info: {
      ...transaction.transaction_info,
      transaction_status: status,
    },
  }
}

  function isSettledPayout(entry) {
    return entry.status === 'PENDING' || entry.result?.status === 'PENDING'
  }

export async function syncPendingPayouts() {
  if (config.useMockPaypal) return []

  const entries = await readLocalTransactions()
  let changed = false
  for (const entry of entries) {
    const payoutBatchId = entry.payoutBatchId || entry.result?.batchId
    if (!payoutBatchId || !isSettledPayout(entry)) continue

    try {
      const payload = await paypalRequest(
        `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`,
      )
      const itemStatuses = payload.items?.map((item) => item.transaction_status).filter(Boolean)
      const status = mapPayoutStatus(
        itemStatuses?.find((item) => mapPayoutStatus(item) !== 'PENDING') ||
          payload.batch_header?.batch_status,
      )
      const fee = Number(
        payload.batch_header?.fees?.value ??
          payload.items?.[0]?.payout_item_fee?.value ??
          0.25,
      )
      if (status === 'PENDING') {
        entry.fee = Number.isFinite(fee) ? Math.abs(fee) : 0.25
        changed = true
        continue
      }

      entry.payoutBatchId = payoutBatchId
      entry.status = status
      entry.fee = Number.isFinite(fee) ? Math.abs(fee) : 0.25
      entry.result = { ...entry.result, batchId: payoutBatchId, status, fee: entry.fee }
      changed = true
    } catch {
      // A transient reporting failure must not hide the local payment record.
    }
  }

  if (changed) await writeLocalTransactions(entries)
  return entries
  }

export async function getAccessToken() {
  if (
    accessTokenCache &&
    accessTokenCache.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS
  ) {
    return accessTokenCache.value
  }

  if (config.useMockPaypal) {
    accessTokenCache = {
      value: 'mock-paypal-access-token',
      expiresAt: Date.now() + 3_600_000,
    }
    return accessTokenCache.value
  }

  const credentials = Buffer.from(
    `${config.paypalClientId}:${config.paypalClientSecret}`,
  ).toString('base64')
  let response

  try {
    response = await fetch(`${config.paypalBaseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
  } catch {
    throw new Error('PayPal authentication is unavailable. Please try again later.')
  }

  const payload = await response.json().catch(() => null)

  if (!response.ok || typeof payload?.access_token !== 'string') {
    throw new Error(getErrorMessage(payload, response.status))
  }

  accessTokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in ?? 0) * 1000,
  }

  return accessTokenCache.value
}

export async function sendPayout({ email, amount, currency, note }) {
  const recipientEmail = assertEmail(email)
  const payoutAmount = assertAmount(amount)
  const payoutCurrency = assertCurrency(currency)

  if (note !== undefined && (typeof note !== 'string' || note.length > 255)) {
    throw new Error('Payout note must be 255 characters or fewer.')
  }

  if (config.useMockPaypal) {
    return {
      batchId: `MOCK-BATCH-${randomUUID().slice(0, 8).toUpperCase()}`,
      status: 'SUCCESS',
    }
  }

  const payload = await paypalRequest('/v1/payments/payouts', {
    method: 'POST',
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: `voicepay-${randomUUID()}`,
        email_subject: 'You have a payment from VoicePay',
        email_message: note || 'You have received a payment from VoicePay.',
      },
      items: [
        {
          recipient_type: 'EMAIL',
          amount: { value: payoutAmount, currency: payoutCurrency },
          receiver: recipientEmail,
          note: note || undefined,
          sender_item_id: `voicepay-item-${randomUUID()}`,
        },
      ],
    }),
  })

  return {
    batchId: payload.batch_header?.payout_batch_id,
    status: payload.batch_header?.batch_status,
    fee: Math.abs(Number(payload.batch_header?.fees?.value ?? 0.25)),
  }
}

export async function getRecentTransactions(limit = 20) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_TRANSACTION_LIMIT
  ) {
    throw new Error(`Transaction limit must be a whole number from 1 to ${MAX_TRANSACTION_LIMIT}.`)
  }

  if (config.useMockPaypal) {
    return {
      transactions: [
        {
          id: 'MOCK-TXN-1001',
          date: new Date().toISOString(),
          status: 'COMPLETED',
          amount: { value: '24.99', currency: 'USD' },
          description: 'VoicePay demo purchase',
        },
      ].slice(0, limit),
      totalItems: 1,
    }
  }

  const endDate = new Date()
  const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000)
  const query = new URLSearchParams({
    start_date: startDate.toISOString(),
    end_date: endDate.toISOString(),
    page_size: String(limit),
    page: '1',
  })
  const transactions = (await fetchReportingTransactions(limit))
    .filter(isActiveOutgoing)

  return {
    transactions,
    totalItems: transactions.length,
  }
}

async function getReportingTransactions(limit = MAX_TRANSACTION_LIMIT) {
  return fetchReportingTransactions(limit)
}

async function fetchReportingTransactions(limit = MAX_TRANSACTION_LIMIT) {
  const endDate = new Date()
  const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000)
  const query = new URLSearchParams({
    start_date: startDate.toISOString(),
    end_date: endDate.toISOString(),
    page_size: String(limit),
    page: '1',
  })
  const payload = await paypalRequest(`/v1/reporting/transactions?${query}`)
  return (payload.transaction_details ?? [])
    .map(normalizeReportedTransaction)
}

function isActiveOutgoing(transaction) {
  const status = transaction.status ||
    transaction.transaction_info?.transaction_status
  return (status === 'COMPLETED' || status === 'PENDING') &&
    !hasSystemFundingContext(transaction) &&
    hasUserPaymentContext(transaction)
}

function getLocalTransactionFee(entry) {
  const fee = Number(entry.fee ?? entry.result?.fee)
  return Number.isFinite(fee) ? Math.abs(fee) : entry.type === 'send_money' ? 0.25 : 0
}

function transactionMatchesLocal(transaction, entry) {
  const info = transaction.transaction_info || {}
  const payoutBatchId = entry.payoutBatchId || entry.result?.batchId
  if (payoutBatchId && info.transaction_id === payoutBatchId) return true

  const amountMatches = Math.abs(getTransactionAmount(transaction) - Number(entry.details?.amount ?? entry.details?.total)) < 0.001
  const recipient = String(entry.details?.email || '').toLowerCase()
  const subject = String(info.transaction_subject || '').toLowerCase()
  const recipientMatches = !recipient || subject.includes(recipient)
  const timestamp = new Date(info.transaction_initiation_date || 0).getTime()
  const localTimestamp = new Date(entry.confirmedAt || entry.createdAt || 0).getTime()
  return amountMatches && recipientMatches &&
    Number.isFinite(timestamp) &&
    Number.isFinite(localTimestamp) &&
    Math.abs(timestamp - localTimestamp) <= 24 * 60 * 60 * 1000
}

export async function getBalances() {
  if (config.useMockPaypal) {
    return {
      balances: [
        { currency: 'USD', available: '1250.00', withheld: '0.00' },
        { currency: 'EUR', available: '500.00', withheld: '0.00' },
      ],
    }
  }

  await syncPendingPayouts()
  const payload = await paypalRequest('/v1/reporting/balances')
  const allReportedTransactions = await getReportingTransactions()
  const reportedTransactions = allReportedTransactions.filter(isActiveOutgoing)
  const localTransactions = await readLocalTransactions()
  const localOutflows = localTransactions.filter((entry) => {
    const resultStatus = entry.result?.status || entry.result?.capture?.status
    const status = entry.status === 'confirmed' ? mapPayoutStatus(resultStatus) : entry.status
    return (
      ((entry.type === 'send_money' && (status === 'COMPLETED' || status === 'PENDING')) ||
        (entry.type === 'purchase' && status === 'COMPLETED')) &&
      (entry.payoutBatchId || entry.result?.batchId)
    )
  })
  const reportedBalance = Number(
    payload.balances?.find((balance) => balance.currency === 'USD')?.available_balance?.value ??
      payload.balances?.find((balance) => balance.currency === 'USD')?.available ??
      0,
  )
  const fundingBalances = allReportedTransactions
    .filter(hasSystemFundingContext)
    .map(getTransactionAmount)
    .filter(Number.isFinite)
  const initialBalance = Math.max(
    ...fundingBalances,
    ...allReportedTransactions.map((transaction) => Number(transaction.endingBalance)).filter(Number.isFinite),
    reportedBalance,
    0,
  )
  const allOutflows = [
    ...reportedTransactions.map((transaction) => ({
      amount: getTransactionAmount(transaction),
      fee: transaction.fee,
      transaction,
    })),
    ...localOutflows
      .filter((entry) => !reportedTransactions.some((transaction) => transactionMatchesLocal(transaction, entry)))
      .map((entry) => ({
        amount: Number(entry.details?.amount ?? entry.details?.total),
        fee: getLocalTransactionFee(entry),
      })),
  ]
  const totalOutflows = allOutflows.reduce((total, item) => total + item.amount + item.fee, 0)
  const effective = reportedBalance >= initialBalance - 0.001
    ? reportedBalance - totalOutflows
    : reportedBalance - allOutflows
      .filter((item) => !item.transaction)
      .reduce((total, item) => total + item.amount + item.fee, 0)

  const balances = (payload.balances ?? []).map((balance) => {
    const reported = Number(balance.available_balance?.value ?? balance.available ?? balance.total_balance?.value ?? 0)
    if (balance.currency !== 'USD' || !Number.isFinite(reported)) return balance
    const value = Math.max(0, Number(effective.toFixed(2)))
    return {
      ...balance,
      available: value.toFixed(2),
      available_balance: balance.available_balance
        ? { ...balance.available_balance, value: value.toFixed(2) }
        : balance.available_balance,
    }
  })

  return { balances }
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Order must include at least one item.')
  }

  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim()) {
      throw new Error(`Order item ${index + 1} must have a name.`)
    }

    const quantity = Number(item.quantity ?? 1)
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`Order item ${index + 1} quantity must be a positive whole number.`)
    }

    const unitAmount = assertAmount(
      item.unitAmount ?? item.unit_amount,
      `Order item ${index + 1} unit amount`,
    )

    return {
      name: item.name.trim(),
      quantity: String(quantity),
      unit_amount: { currency_code: item.currency ?? 'USD', value: unitAmount },
    }
  })
}

export async function createOrder({ items, total, currency }) {
  const orderCurrency = assertCurrency(currency)
  const orderTotal = assertAmount(total, 'Order total')
  const orderItems = normalizeItems(items).map((item) => ({
    ...item,
    unit_amount: { ...item.unit_amount, currency_code: orderCurrency },
  }))

  if (config.useMockPaypal) {
    const orderId = `MOCK-ORDER-${randomUUID().slice(0, 8).toUpperCase()}`
    mockOrders.set(orderId, { status: 'CREATED', total: orderTotal })
    return {
      orderId,
      approvalLink: config.paypalVaultId
        ? null
        : `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
      paymentPath: config.paypalVaultId ? 'vaulted' : 'approval',
    }
  }

  const orderBody = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        amount: {
          currency_code: orderCurrency,
          value: orderTotal,
          breakdown: {
            item_total: { currency_code: orderCurrency, value: orderTotal },
          },
        },
        items: orderItems,
      },
    ],
  }

  if (config.paypalVaultId) {
    orderBody.payment_source = {
      card: {
        vault_id: config.paypalVaultId,
      },
    }
  }

  const payload = await paypalRequest('/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify(orderBody),
  })

  return {
    orderId: payload.id,
    approvalLink: payload.links?.find((link) => link.rel === 'approve')?.href,
    paymentPath: config.paypalVaultId ? 'vaulted' : 'approval',
  }
}

export async function captureOrder(orderId) {
  if (typeof orderId !== 'string' || !orderId.trim()) {
    throw new Error('Order ID is required to capture an order.')
  }

  if (config.useMockPaypal) {
    const order = mockOrders.get(orderId)
    if (!order) {
      throw new Error('The requested order was not found.')
    }
    order.status = 'COMPLETED'
    return { orderId, status: order.status, captureId: `MOCK-CAPTURE-${randomUUID().slice(0, 8).toUpperCase()}` }
  }

  const payload = await paypalRequest(
    `/v2/checkout/orders/${encodeURIComponent(orderId.trim())}/capture`,
    { method: 'POST', body: JSON.stringify({}) },
  )

  return {
    orderId: payload.id,
    status: payload.status,
    captureId: payload.purchase_units?.[0]?.payments?.captures?.[0]?.id,
  }
}

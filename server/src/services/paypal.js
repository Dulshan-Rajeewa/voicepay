import { randomUUID } from 'node:crypto'
import { config } from '../config.js'

const TOKEN_REFRESH_BUFFER_MS = 60_000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CURRENCY_PATTERN = /^[A-Z]{3}$/
const MAX_TRANSACTION_LIMIT = 500

let accessTokenCache = null
const mockOrders = new Map()

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
  const payload = await paypalRequest(`/v1/reporting/transactions?${query}`)

  return {
    transactions: payload.transaction_details ?? [],
    totalItems: payload.total_items ?? payload.transaction_details?.length ?? 0,
  }
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

  const payload = await paypalRequest('/v1/reporting/balances')

  return { balances: payload.balances ?? [] }
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

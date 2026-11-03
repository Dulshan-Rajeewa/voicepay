import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, isDeviceAuthRequired } from '../config.js'
import { captureOrder, createOrder, sendPayout } from './paypal.js'

const ACTION_TTL_MS = 5 * 60 * 1000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const actions = new Map()
const pendingActionStorePath =
  config.pendingActionStorePath ||
  fileURLToPath(new URL('../../data/pending-actions.json', import.meta.url))
const transactionLogPath =
  config.transactionLogPath ||
  fileURLToPath(new URL('../../data/transactions.json', import.meta.url))
const legacyTransactionLogPath = fileURLToPath(
  new URL('../data/transactions.json', import.meta.url),
)

function loadActions() {
  try {
    const contents = readFileSync(pendingActionStorePath, 'utf8')
    const storedActions = JSON.parse(contents)
    if (!Array.isArray(storedActions)) return
    for (const action of storedActions) {
      if (action?.id && (action.status === 'pending' || action.status === 'processing')) {
        if (action.status === 'processing') action.status = 'pending'
        markExpired(action)
        if (action.status === 'pending') actions.set(action.id, action)
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error('The pending action store could not be read.')
    }
  }
}

function saveActions() {
  try {
    mkdirSync(path.dirname(pendingActionStorePath), { recursive: true })
    writeFileSync(
      pendingActionStorePath,
      `${JSON.stringify([...actions.values()], null, 2)}\n`,
    )
  } catch {
    throw new Error('The pending action store could not be saved.')
  }
}

function assertAmount(amount, label) {
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

  return numericAmount
}

function validateDetails(action) {
  if (!action.details || typeof action.details !== 'object') {
    throw new Error('Action details are missing.')
  }

  if (action.type === 'send_money') {
    const { email, amount, currency } = action.details

    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
      throw new Error('Recipient email must be a valid email address.')
    }

    assertAmount(amount, 'Payment amount')

    if (currency !== 'USD') {
      throw new Error('Only USD payments are supported.')
    }

    return
  }

  if (action.type === 'purchase') {
    const { items, total, currency } = action.details

    assertAmount(total, 'Purchase total')

    if (currency !== 'USD') {
      throw new Error('Only USD purchases are supported.')
    }

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('Purchase must include at least one item.')
    }

    items.forEach((item, index) => {
      if (!item || typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error(`Purchase item ${index + 1} must have a name.`)
      }

      const quantity = Number(item.quantity ?? 1)
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new Error(
          `Purchase item ${index + 1} quantity must be a positive whole number.`,
        )
      }

      assertAmount(
        item.unitAmount ?? item.unit_amount,
        `Purchase item ${index + 1} unit amount`,
      )
    })

    return
  }

  throw new Error('This pending action type is not supported.')
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function getActionDetailsHash(action) {
  return createHash('sha256')
    .update(stableStringify(action.details))
    .digest('base64url')
}

export function recordDeviceApproval(action, userId, sessionId, detailsHash) {
  action.deviceApproved = true
  action.deviceApprovedAt = new Date().toISOString()
  action.deviceApprovalDetailsHash = detailsHash
  action.deviceApprovalUserId = userId
  action.deviceApprovalSessionId = sessionId
}

function requireDeviceApproval(action, sessionId) {
  if (!isDeviceAuthRequired()) return

  const approvedAt = new Date(action.deviceApprovedAt || 0).getTime()
  const approvedRecently = Number.isFinite(approvedAt) && Date.now() - approvedAt <= 2 * 60 * 1000
  const unchanged = action.deviceApprovalDetailsHash === getActionDetailsHash(action)
  const sameSession = action.deviceApprovalSessionId === sessionId

  if (!action.deviceApproved || !approvedRecently || !unchanged || !sameSession) {
    const error = new Error('Check it is you on this device before confirming the payment.')
    error.code = 'NEEDS_DEVICE_APPROVAL'
    throw error
  }
}

function markExpired(action) {
  if (action.status === 'pending' && new Date(action.expiresAt).getTime() <= Date.now()) {
    action.status = 'expired'
  }
}

loadActions()

async function readTransactionLog() {
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

async function logTransaction(entry) {
  const entries = await readTransactionLog()
  entries.push(entry)

  try {
    await mkdir(path.dirname(transactionLogPath), { recursive: true })
    await writeFile(transactionLogPath, `${JSON.stringify(entries, null, 2)}\n`)
  } catch {
    throw new Error('The local transaction log could not be saved.')
  }
}

export function createPendingAction({
  type,
  details,
  humanSummary,
  sessionId,
  createdAt = new Date(),
  expiresAt = new Date(new Date(createdAt).getTime() + ACTION_TTL_MS),
}) {
  if (type !== 'send_money' && type !== 'purchase') {
    throw new Error('Pending action type must be send_money or purchase.')
  }

  if (typeof humanSummary !== 'string' || !humanSummary.trim()) {
    throw new Error('Pending action needs a spoken summary.')
  }

  const action = {
    id: randomUUID(),
    type,
    details,
    humanSummary: humanSummary.trim(),
    sessionId,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    status: 'pending',
  }

  actions.set(action.id, action)
  saveActions()
  return action
}

export function getPendingAction(actionId, sessionId) {
  const action = actions.get(actionId)
  if (action?.sessionId && action.sessionId !== sessionId) {
    throw new Error('Pending action was not found.')
  }
  if (action) {
    markExpired(action)
  }
  return action
}

export function toPublicPendingAction(action) {
  if (!action) return null
  const {
    sessionId: _sessionId,
    deviceApprovalNonce: _deviceApprovalNonce,
    deviceApprovalChallenge: _deviceApprovalChallenge,
    deviceApprovalSessionId: _deviceApprovalSessionId,
    deviceApprovalUserId: _deviceApprovalUserId,
    deviceApprovalDetailsHash: _deviceApprovalDetailsHash,
    ...publicAction
  } = action
  return publicAction
}

export function cancelPendingAction(actionId, sessionId) {
  const action = getPendingAction(actionId, sessionId)

  if (!action) {
    throw new Error('Pending action was not found.')
  }

  if (action.status === 'expired') {
    throw new Error('This pending action has expired.')
  }

  if (action.status !== 'pending') {
    throw new Error('This action can no longer be cancelled.')
  }

  action.status = 'cancelled'
  saveActions()
  return action
}

export async function confirmPendingAction(
  actionId,
  confirmation,
  execute = executePayment,
  sessionId,
) {
  if (confirmation !== true) {
    throw new Error('Explicit confirmation is required.')
  }

  const action = getPendingAction(actionId, sessionId)

  if (!action) {
    throw new Error('Pending action was not found.')
  }

  if (action.status === 'expired') {
    throw new Error('This pending action has expired.')
  }

  if (action.status !== 'pending') {
    throw new Error('This action has already been processed.')
  }

  requireDeviceApproval(action, sessionId)
  validateDetails(action)
  action.status = 'processing'
  saveActions()

  try {
    const result = await execute(action)
    action.status = 'completed'
    action.result = result
    saveActions()
    await logTransaction({
      actionId: action.id,
      type: action.type,
      status: result?.status === 'PENDING' ? 'PENDING' : 'confirmed',
      payoutBatchId: result?.batchId,
      details: action.details,
      humanSummary: action.humanSummary,
      result,
      createdAt: action.createdAt,
      confirmedAt: new Date().toISOString(),
    })
    return action
  } catch (error) {
    action.status = 'failed'
    saveActions()
    throw error
  }
}

async function executePayment(action) {
  if (action.type === 'send_money') {
    return sendPayout(action.details)
  }

  const order = await createOrder(action.details)
  if (order.paymentPath === 'approval') {
    return {
      order,
      status: 'AWAITING_APPROVAL',
      message: 'PayPal approval is required before this purchase can be captured.',
    }
  }
  const capture = await captureOrder(order.orderId)
  return { order, capture }
}

export async function logCancelledAction(action) {
  await logTransaction({
    actionId: action.id,
    type: action.type,
    status: 'cancelled',
    details: action.details,
    humanSummary: action.humanSummary,
    createdAt: action.createdAt,
    cancelledAt: new Date().toISOString(),
  })
}

export async function getTransactionLog() {
  return readTransactionLog()
}

export function clearPendingActions() {
  actions.clear()
}

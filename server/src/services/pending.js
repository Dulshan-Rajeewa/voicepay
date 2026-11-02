import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { captureOrder, createOrder, sendPayout } from './paypal.js'

const ACTION_TTL_MS = 5 * 60 * 1000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const actions = new Map()
const transactionLogPath =
  config.transactionLogPath ||
  fileURLToPath(new URL('../data/transactions.json', import.meta.url))

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

function markExpired(action) {
  if (action.status === 'pending' && new Date(action.expiresAt).getTime() <= Date.now()) {
    action.status = 'expired'
  }
}

async function readTransactionLog() {
  try {
    const contents = await readFile(transactionLogPath, 'utf8')
    const entries = JSON.parse(contents)
    return Array.isArray(entries) ? entries : []
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw new Error('The local transaction log could not be read.')
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
  const { sessionId: _sessionId, ...publicAction } = action
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

  validateDetails(action)
  action.status = 'processing'

  try {
    const result = await execute(action)
    action.status = 'completed'
    action.result = result
    await logTransaction({
      actionId: action.id,
      type: action.type,
      status: 'confirmed',
      details: action.details,
      humanSummary: action.humanSummary,
      result,
      createdAt: action.createdAt,
      confirmedAt: new Date().toISOString(),
    })
    return action
  } catch (error) {
    action.status = 'failed'
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

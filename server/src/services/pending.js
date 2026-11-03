import { createHash, randomUUID } from 'node:crypto'
import { config, isDeviceAuthRequired } from '../config.js'
import {
  addTransaction,
  claimPendingAction,
  createPendingAction as savePendingAction,
  getPendingAction as readPendingAction,
  listTransactions,
  updatePendingAction,
  getStorageDriver,
} from '../db/index.js'
import { captureOrder, createOrder, sendPayout } from './paypal.js'

const ACTION_TTL_MS = 5 * 60 * 1000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const actionReferences = new Map()

function assertAmount(amount, label) {
  const numericAmount = Number(amount)
  if (!Number.isFinite(numericAmount) || numericAmount <= 0 ||
      Math.abs(numericAmount * 100 - Math.round(numericAmount * 100)) > 1e-9) {
    throw new Error(`${label} must be a positive amount with at most two decimals.`)
  }
  if (numericAmount > config.maxPaymentUsd) {
    throw new Error(`${label} cannot be greater than ${config.maxPaymentUsd.toFixed(2)} USD.`)
  }
  return numericAmount
}

function validateDetails(action) {
  if (!action.details || typeof action.details !== 'object') throw new Error('Action details are missing.')
  if (action.type === 'send_money') {
    const { email, amount, currency } = action.details
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
      throw new Error('Recipient email must be a valid email address.')
    }
    assertAmount(amount, 'Payment amount')
    if (currency !== 'USD') throw new Error('Only USD payments are supported.')
    return
  }
  if (action.type === 'purchase') {
    const { items, total, currency } = action.details
    assertAmount(total, 'Purchase total')
    if (currency !== 'USD') throw new Error('Only USD purchases are supported.')
    if (!Array.isArray(items) || items.length === 0) throw new Error('Purchase must include at least one item.')
    items.forEach((item, index) => {
      if (!item || typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error(`Purchase item ${index + 1} must have a name.`)
      }
      const quantity = Number(item.quantity ?? 1)
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new Error(`Purchase item ${index + 1} quantity must be a positive whole number.`)
      }
      assertAmount(item.unitAmount ?? item.unit_amount, `Purchase item ${index + 1} unit amount`)
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
  return createHash('sha256').update(stableStringify(action.details)).digest('base64url')
}

export async function recordDeviceApproval(action, userId, sessionId, detailsHash) {
  const approved = {
    ...action,
    deviceApproved: true,
    deviceApprovedAt: new Date().toISOString(),
    deviceApprovalDetailsHash: detailsHash,
    deviceApprovalUserId: userId,
    deviceApprovalSessionId: sessionId,
  }
  await updatePendingAction(approved)
  Object.assign(action, approved)
  return action
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
  return action?.status === 'pending' && new Date(action.expiresAt).getTime() <= Date.now()
}

export async function createPendingAction({
  type,
  details,
  humanSummary,
  sessionId,
  userId = sessionId,
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
    userId,
    type,
    details,
    humanSummary: humanSummary.trim(),
    sessionId,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    status: 'pending',
  }
  await savePendingAction(action)
  actionReferences.set(action.id, action)
  return action
}

export async function getPendingAction(actionId, sessionId) {
  if (getStorageDriver() === 'file' && actionReferences.has(actionId)) {
    const referenced = actionReferences.get(actionId)
    if (referenced.sessionId && referenced.sessionId !== sessionId) return null
    if (markExpired(referenced)) {
      referenced.status = 'expired'
      await updatePendingAction(referenced)
    }
    return referenced
  }
  const action = await readPendingAction(actionId, sessionId)
  if (action && markExpired(action)) {
    action.status = 'expired'
    await updatePendingAction(action)
  }
  return action
}

export function toPublicPendingAction(action) {
  if (!action) return null
  const {
    userId: _userId,
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

export async function cancelPendingAction(actionId, sessionId) {
  const action = await getPendingAction(actionId, sessionId)
  if (!action) throw new Error('Pending action was not found.')
  if (action.status === 'expired') throw new Error('This pending action has expired.')
  if (action.status !== 'pending') throw new Error('This action can no longer be cancelled.')
  action.status = 'cancelled'
  await updatePendingAction(action)
  Object.assign(actionReferences.get(action.id) || {}, action)
  return action
}

export async function confirmPendingAction(actionId, confirmation, execute = executePayment, sessionId) {
  if (confirmation !== true) throw new Error('Explicit confirmation is required.')
  const action = await getPendingAction(actionId, sessionId)
  if (!action) throw new Error('Pending action was not found.')
  if (action.status === 'expired') throw new Error('This pending action has expired.')
  if (action.status !== 'pending') throw new Error('This action has already been processed.')
  requireDeviceApproval(action, sessionId)
  validateDetails(action)

  const claimed = await claimPendingAction(actionId, sessionId)
  if (!claimed) throw new Error('This action has already been processed.')
  try {
    const result = await execute(claimed)
    const completed = { ...claimed, status: 'completed', result }
    await updatePendingAction(completed)
    Object.assign(actionReferences.get(claimed.id) || {}, completed)
    await addTransaction(sessionId, {
      actionId: claimed.id,
      type: claimed.type,
      status: result?.status === 'PENDING' ? 'PENDING' : 'confirmed',
      payoutBatchId: result?.batchId,
      fee: result?.fee,
      details: claimed.details,
      humanSummary: claimed.humanSummary,
      result,
      createdAt: claimed.createdAt,
      confirmedAt: new Date().toISOString(),
    })
    return completed
  } catch (error) {
    await updatePendingAction({ ...claimed, status: 'failed' })
    Object.assign(actionReferences.get(claimed.id) || {}, { ...claimed, status: 'failed' })
    throw error
  }
}

async function executePayment(action) {
  if (action.type === 'send_money') return sendPayout(action.details)
  const order = await createOrder(action.details)
  if (order.paymentPath === 'approval') {
    return { order, status: 'AWAITING_APPROVAL', message: 'PayPal approval is required before this purchase can be captured.' }
  }
  const capture = await captureOrder(order.orderId)
  return { order, capture }
}

export async function logCancelledAction(action) {
  await addTransaction(action.userId || action.sessionId, {
    actionId: action.id,
    type: action.type,
    status: 'cancelled',
    details: action.details,
    humanSummary: action.humanSummary,
    createdAt: action.createdAt,
    cancelledAt: new Date().toISOString(),
  })
}

export async function getTransactionLog(userId = 'default') {
  return listTransactions(userId, 20)
}

export function clearPendingActions() {
  actionReferences.clear()
}

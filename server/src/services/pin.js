import { promisify } from 'node:util'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { getPinRecord, savePinRecord } from '../db/index.js'
import { getActionDetailsHash, getPendingAction, recordApproval } from './pending.js'

const scryptAsync = promisify(scrypt)
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000
const APPROVAL_MS = 2 * 60 * 1000

function pinError(message, code = 'PIN_ERROR') {
  return Object.assign(new Error(message), { code })
}

function validatePin(pin) {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    throw pinError('Your VoicePay PIN must be six digits.', 'PIN_INVALID')
  }
}

async function hashPin(pin, salt = randomBytes(16)) {
  const derived = await scryptAsync(pin, salt, 64)
  return { salt: salt.toString('base64url'), hash: Buffer.from(derived).toString('base64url') }
}

async function matchesPin(pin, record) {
  const derived = await scryptAsync(pin, Buffer.from(record.salt, 'base64url'), 64)
  const expected = Buffer.from(record.hash, 'base64url')
  return expected.length === derived.length && timingSafeEqual(expected, derived)
}

export async function setPin(userId, pin, currentPin = null) {
  if (!config.allowPinFallback) throw pinError('PIN fallback is not available.', 'PIN_DISABLED')
  validatePin(pin)
  const existing = await getPinRecord(userId)
  if (existing) {
    if (!currentPin) throw pinError('Your current PIN is required.', 'PIN_CURRENT_REQUIRED')
    await verifyPin(userId, currentPin)
  }
  const hashed = await hashPin(pin)
  await savePinRecord(userId, {
    ...hashed,
    failedAttempts: 0,
    lockedUntil: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  return { configured: true }
}

export async function verifyPin(userId, pin) {
  validatePin(pin)
  const record = await getPinRecord(userId)
  if (!record) throw pinError('PIN approval is not available.', 'PIN_NOT_CONFIGURED')
  const lockedUntil = new Date(record.lockedUntil || 0).getTime()
  if (lockedUntil > Date.now()) throw pinError('PIN approval is temporarily locked. Try again later.', 'PIN_LOCKED')
  const valid = await matchesPin(pin, record)
  if (valid) {
    await savePinRecord(userId, { ...record, failedAttempts: 0, lockedUntil: null })
    return true
  }
  const failedAttempts = Number(record.failedAttempts || 0) + 1
  await savePinRecord(userId, {
    ...record,
    failedAttempts,
    lockedUntil: failedAttempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null,
  })
  throw pinError('The PIN was not accepted. Try again.', failedAttempts >= MAX_ATTEMPTS ? 'PIN_LOCKED' : 'PIN_INCORRECT')
}

export async function getPinStatus(userId) {
  const record = await getPinRecord(userId)
  const lockedUntil = record?.lockedUntil && new Date(record.lockedUntil).getTime() > Date.now()
    ? record.lockedUntil
    : null
  return { configured: Boolean(record), lockedUntil, allowed: config.allowPinFallback }
}

export async function approveWithPin(userId, sessionId, actionId, pin) {
  if (!config.allowPinFallback) throw pinError('PIN fallback is not available.', 'PIN_DISABLED')
  const action = await getPendingAction(actionId, sessionId)
  if (!action || action.status !== 'pending') throw pinError('This payment is no longer available.', 'ACTION_NOT_AVAILABLE')
  if (action.deviceApproved) throw pinError('This payment has already been approved.', 'APPROVAL_ALREADY_USED')
  const record = await getPinRecord(userId)
  if (!record) throw pinError('PIN approval is not available.', 'PIN_NOT_CONFIGURED')
  await verifyPin(userId, pin)
  const approvedAt = new Date().toISOString()
  const approved = await recordApproval(action, userId, sessionId, getActionDetailsHash(action), 'pin')
  approved.deviceApprovedAt = approvedAt
  return { approved: true, approvalMethod: 'pin' }
}

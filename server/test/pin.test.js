import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

process.env.USE_MOCK_PAYPAL = 'true'
process.env.STORAGE_DRIVER = 'file'
process.env.REQUIRE_DEVICE_AUTH = 'true'
process.env.ALLOW_PIN_FALLBACK = 'true'

const { createPendingAction, confirmPendingAction } = await import('../src/services/pending.js')
const { approveWithPin, setPin, verifyPin } = await import('../src/services/pin.js')

const details = (amount = '20.00') => ({
  email: 'nimal@example.com',
  amount,
  currency: 'USD',
  note: 'PIN test',
})

async function action(userId = `pin-user-${randomUUID()}`, amount = '20.00', expiresAt) {
  const created = await createPendingAction({
    type: 'send_money',
    details: details(amount),
    humanSummary: 'PIN test payment.',
    sessionId: userId,
    userId,
    expiresAt,
  })
  return { created, userId }
}

test('rejects wrong PIN and locks after five attempts', async () => {
  const userId = `wrong-${randomUUID()}`
  await setPin(userId, '123456')
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(verifyPin(userId, '000000'), (error) => error.code === 'PIN_INCORRECT')
  }
  await assert.rejects(verifyPin(userId, '000000'), (error) => error.code === 'PIN_LOCKED')
  await assert.rejects(verifyPin(userId, '123456'), (error) => error.code === 'PIN_LOCKED')
})

test('approves one action only and cannot approve another action', async () => {
  const userId = `replay-${randomUUID()}`
  await setPin(userId, '123456')
  const first = await action(userId)
  const second = await action(userId, '21.00')
  await approveWithPin(userId, userId, first.created.id, '123456')
  await assert.rejects(approveWithPin(userId, userId, first.created.id, '123456'), (error) => error.code === 'APPROVAL_ALREADY_USED')
  await assert.doesNotReject(approveWithPin(userId, userId, second.created.id, '123456'))
})

test('rejects expired, tampered, and unapproved PIN actions at confirmation', async () => {
  const userId = `expired-${randomUUID()}`
  await setPin(userId, '123456')
  const expired = await action(userId, '20.00', new Date(Date.now() - 1000))
  await assert.rejects(approveWithPin(userId, userId, expired.created.id, '123456'), (error) => error.code === 'ACTION_NOT_AVAILABLE')

  const tampered = await action(userId)
  await approveWithPin(userId, userId, tampered.created.id, '123456')
  tampered.created.details.amount = '90.00'
  await assert.rejects(
    confirmPendingAction(tampered.created.id, true, async () => ({ status: 'SUCCESS' }), userId),
    (error) => error.code === 'NEEDS_DEVICE_APPROVAL',
  )
})

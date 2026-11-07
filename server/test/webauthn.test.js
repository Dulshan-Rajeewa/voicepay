import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

process.env.USE_MOCK_PAYPAL = 'true'
process.env.STORAGE_DRIVER = 'file'
process.env.MAX_PAYMENT_USD = '100'
process.env.REQUIRE_DEVICE_AUTH = 'true'
process.env.CREDENTIAL_STORE_PATH = path.join(
  os.tmpdir(),
  `voicepay-credentials-webauthn-${process.pid}.json`,
)
process.env.PENDING_ACTION_STORE_PATH = path.join(
  os.tmpdir(),
  `voicepay-pending-actions-webauthn-${process.pid}.json`,
)

const {
  clearPendingActions,
  confirmPendingAction,
  createPendingAction,
  getActionDetailsHash,
  recordDeviceApproval,
} = await import('../src/services/pending.js')
const {
  clearWebAuthnState,
  expireApprovalForTest,
  getApprovalOptions,
  getRegistrationOptions,
  verifyApproval,
  verifyRegistration,
} = await import('../src/services/webauthn.js')

const credentialsPath = process.env.CREDENTIAL_STORE_PATH
const pendingActionsPath = process.env.PENDING_ACTION_STORE_PATH

const sendDetails = (amount = '20.00') => ({
  email: 'nimal@example.com',
  amount,
  currency: 'USD',
  note: 'Test payment',
})

async function setupCredential() {
  await getRegistrationOptions('test-user')
  await verifyRegistration(
    'test-user',
    { id: 'registration', response: {} },
    'Test laptop',
    async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'credential-1',
          publicKey: Uint8Array.from([1, 2, 3]),
          counter: 1,
          transports: ['internal'],
        },
      },
    }),
  )
}

function createAction(amount = '20.00', id = undefined) {
  return createPendingAction({
    id,
    type: 'send_money',
    details: sendDetails(amount),
    humanSummary: 'Send 20 dollars to Nimal. Say confirm to send, or cancel.',
    sessionId: 'session-1',
  })
}

afterEach(async () => {
  process.env.REQUIRE_DEVICE_AUTH = 'true'
  clearPendingActions()
  clearWebAuthnState()
  await unlink(credentialsPath).catch(() => {})
  await unlink(pendingActionsPath).catch(() => {})
})

test('refuses confirmation without device approval', async () => {
  const action = await createAction()
  await assert.rejects(
    confirmPendingAction(action.id, true, async () => ({ status: 'SUCCESS' }), 'session-1'),
    (error) => error.code === 'NEEDS_DEVICE_APPROVAL',
  )
})

test('keeps the registration challenge unchanged for browser verification', async () => {
  const options = await getRegistrationOptions('challenge-user')
  let expectedChallenge
  await verifyRegistration(
    'challenge-user',
    { id: 'registration', response: {} },
    'Test laptop',
    async ({ expectedChallenge: challenge }) => {
      expectedChallenge = challenge
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: 'challenge-credential',
            publicKey: Uint8Array.from([1, 2, 3]),
            counter: 1,
            transports: ['internal'],
          },
        },
      }
    },
  )
  assert.equal(options.challenge, expectedChallenge)
})

test('keeps a registration challenge across a simulated cold start', async () => {
  const options = await getRegistrationOptions('cold-start-user')
  clearWebAuthnState()
  let expectedChallenge
  await verifyRegistration(
    'cold-start-user',
    { id: 'registration', response: {} },
    'Cold start phone',
    async ({ expectedChallenge: challenge }) => {
      expectedChallenge = challenge
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: 'cold-start-credential',
            publicKey: Uint8Array.from([1, 2, 3]),
            counter: 1,
            transports: ['internal'],
          },
        },
      }
    },
  )
  assert.equal(options.challenge, expectedChallenge)
})

test('rejects a wrong challenge', async () => {
  await setupCredential()
  const action = await createAction()
  const options = await getApprovalOptions(action.id, 'session-1', 'test-user')
  await assert.rejects(
    verifyApproval(
      action.id,
      'session-1',
      'test-user',
      { id: 'credential-1', challenge: 'wrong-challenge' },
      async ({ expectedChallenge, response }) => ({
        verified: response.challenge === expectedChallenge,
        authenticationInfo: { newCounter: 2 },
      }),
    ),
    /could not verify/,
  )
  assert.notEqual(options.challenge, 'wrong-challenge')
  assert.equal(action.deviceApproved, undefined)
})

test('consumes an approval assertion only once', async () => {
  await setupCredential()
  const action = await createAction()
  await getApprovalOptions(action.id, 'session-1', 'test-user')
  const verifier = async () => ({
    verified: true,
    authenticationInfo: { newCounter: 2 },
  })
  await verifyApproval(action.id, 'session-1', 'test-user', { id: 'credential-1' }, verifier)
  await assert.rejects(
    verifyApproval(action.id, 'session-1', 'test-user', { id: 'credential-1' }, verifier),
    /expired/,
  )
})

test('cannot use action A approval for action B', async () => {
  await setupCredential()
  const actionA = await createAction('20.00')
  const actionB = await createAction('21.00')
  await getApprovalOptions(actionA.id, 'session-1', 'test-user')
  await assert.rejects(
    verifyApproval(actionB.id, 'session-1', 'test-user', { id: 'credential-1' }, async () => ({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    })),
    /expired/,
  )
  assert.equal(actionB.deviceApproved, undefined)
})

test('refuses an expired approval', async () => {
  await setupCredential()
  const action = await createAction()
  await getApprovalOptions(action.id, 'session-1', 'test-user')
  expireApprovalForTest(action.id)
  await assert.rejects(
    verifyApproval(action.id, 'session-1', 'test-user', { id: 'credential-1' }, async () => ({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    })),
    /expired/,
  )
})

test('refuses a tampered amount after approval', async () => {
  const action = await createAction()
  await recordDeviceApproval(action, 'test-user', 'session-1', getActionDetailsHash(action))
  action.details.amount = '90.00'
  await assert.rejects(
    confirmPendingAction(action.id, true, async () => ({ status: 'SUCCESS' }), 'session-1'),
    (error) => error.code === 'NEEDS_DEVICE_APPROVAL',
  )
})

test('rejects an authenticator counter rollback', async () => {
  await setupCredential()
  const action = await createAction()
  await getApprovalOptions(action.id, 'session-1', 'test-user')
  await assert.rejects(
    verifyApproval(action.id, 'session-1', 'test-user', { id: 'credential-1' }, async () => ({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    })),
    /already used/,
  )
})

test('allows the DEMO ONLY path when device auth is disabled', async () => {
  process.env.REQUIRE_DEVICE_AUTH = 'false'
  const action = await createAction()
  let executed = false
  await confirmPendingAction(action.id, true, async () => {
    executed = true
    return { status: 'SUCCESS' }
  }, 'session-1')
  assert.equal(executed, true)
})

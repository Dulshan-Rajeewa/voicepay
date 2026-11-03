import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { config, isDeviceAuthRequired } from '../config.js'
import {
  getActionDetailsHash,
  getPendingAction,
  recordDeviceApproval,
} from './pending.js'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const USER_COOKIE = 'voicepay-user-id'
const defaultCredentialStorePath =
  config.credentialStorePath ||
  fileURLToPath(new URL('../data/credentials.json', import.meta.url))
const registrationChallenges = new Map()
const approvalChallenges = new Map()
const practiceChallenges = new Map()

function getCredentialStorePath() {
  return process.env.CREDENTIAL_STORE_PATH || defaultCredentialStorePath
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function fromBase64Url(value) {
  return Buffer.from(value, 'base64url')
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([name, value]) => name && value)
      .map(([name, ...value]) => [name, value.join('=')]),
  )
}

export function getOrCreateUserId(request, response) {
  const existing = parseCookies(request.headers.cookie)[USER_COOKIE]
  if (existing) return existing

  const userId = randomUUID()
  const secure = request.secure ? '; Secure' : ''
  response.append(
    'Set-Cookie',
    `${USER_COOKIE}=${userId}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${secure}`,
  )
  return userId
}

async function readCredentialStore() {
  try {
    const contents = await readFile(getCredentialStorePath(), 'utf8')
    const store = JSON.parse(contents)
    return store && typeof store === 'object' && !Array.isArray(store) ? store : {}
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error('The device credential store could not be read.')
  }
}

async function writeCredentialStore(store) {
  try {
    await mkdir(path.dirname(getCredentialStorePath()), { recursive: true })
    await writeFile(getCredentialStorePath(), `${JSON.stringify(store, null, 2)}\n`)
  } catch {
    throw new Error('The device credential store could not be saved.')
  }
}

async function getCredentials(userId) {
  const store = await readCredentialStore()
  return Array.isArray(store[userId]) ? store[userId] : []
}

function cleanError(error, fallback = 'Device confirmation could not be completed.') {
  const clean = new Error(error?.message || fallback)
  clean.code = error?.code || 'WEBAUTHN_ERROR'
  return clean
}

function getActionBinding(action, nonce) {
  const amount = action.details?.amount ?? action.details?.total ?? ''
  const recipient = action.details?.email ?? action.details?.contactName ?? action.details?.name ?? ''
  const product = action.details?.productId ??
    action.details?.items?.map((item) => item.productId ?? item.name).join('|') ??
    ''
  return `${nonce}${action.id}${action.type}${amount}${recipient}${product}`
}

export function createActionChallenge(action, nonce = randomBytes(32)) {
  return toBase64Url(createHash('sha256').update(getActionBinding(action, nonce)).digest())
}

export async function getRegistrationOptions(userId) {
  const credentials = await getCredentials(userId)
  const challenge = toBase64Url(randomBytes(32))
  registrationChallenges.set(userId, {
    challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  })

  return generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: userId,
    userID: Buffer.from(userId),
    challenge,
    userDisplayName: 'VoicePay user',
    attestationType: 'none',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'required',
    },
    excludeCredentials: credentials.map((credential) => ({
      id: credential.credentialID,
      transports: credential.transports,
    })),
  })
}

export async function verifyRegistration(
  userId,
  response,
  deviceLabel = 'This device',
  verifyFn = verifyRegistrationResponse,
) {
  const challengeEntry = registrationChallenges.get(userId)
  registrationChallenges.delete(userId)
  if (!challengeEntry || challengeEntry.expiresAt <= Date.now()) {
    throw Object.assign(new Error('Registration has expired. Please start again.'), {
      code: 'WEBAUTHN_CHALLENGE_EXPIRED',
    })
  }

  try {
    const verification = await verifyFn({
      response,
      expectedChallenge: challengeEntry.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    })

    if (!verification.verified) {
      throw new Error('The device could not verify you. Please try again.')
    }

    const credential = verification.registrationInfo.credential
    const store = await readCredentialStore()
    const current = Array.isArray(store[userId]) ? store[userId] : []
    store[userId] = [
      ...current.filter((item) => item.credentialID !== credential.id),
      {
        credentialID: credential.id,
        publicKey: toBase64Url(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports || response.response?.transports || [],
        createdAt: new Date().toISOString(),
        deviceLabel: String(deviceLabel).trim().slice(0, 80) || 'This device',
      },
    ]
    await writeCredentialStore(store)
    return { registered: true }
  } catch (error) {
    throw cleanError(error, 'The device could not be registered. Please try again.')
  }
}

export async function getStatus(userId) {
  const credentials = await getCredentials(userId)
  return { registered: credentials.length > 0, required: isDeviceAuthRequired() }
}

export async function removeCredentials(userId) {
  const store = await readCredentialStore()
  delete store[userId]
  await writeCredentialStore(store)
  return { registered: false }
}

export async function getApprovalOptions(actionId, sessionId, userId) {
  const action = getPendingAction(actionId, sessionId)
  if (!action) throw new Error('Pending action was not found.')
  if (action.status !== 'pending') throw new Error('This action can no longer be approved.')

  const credentials = await getCredentials(userId)
  if (credentials.length === 0) {
    throw Object.assign(new Error('No device is set up. Open Settings and set up this device first.'), {
      code: 'DEVICE_NOT_REGISTERED',
    })
  }

  const nonce = toBase64Url(randomBytes(32))
  const challenge = createActionChallenge(action, nonce)
  action.deviceApprovalNonce = nonce
  action.deviceApprovalChallenge = challenge
  action.deviceApprovalSessionId = sessionId
  approvalChallenges.set(action.id, {
    challenge,
    actionId: action.id,
    sessionId,
    userId,
    detailsHash: getActionDetailsHash(action),
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  })

  return generateAuthenticationOptions({
    rpID: config.rpId,
    challenge,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialID,
      transports: credential.transports,
    })),
    userVerification: 'required',
  })
}

export async function verifyApproval(
  actionId,
  sessionId,
  userId,
  response,
  verifyFn = verifyAuthenticationResponse,
) {
  const pending = approvalChallenges.get(actionId)
  approvalChallenges.delete(actionId)
  const action = getPendingAction(actionId, sessionId)

  if (!pending || pending.expiresAt <= Date.now()) {
    throw Object.assign(new Error('Device approval has expired. Please try again.'), {
      code: 'WEBAUTHN_CHALLENGE_EXPIRED',
    })
  }
  if (pending.sessionId !== sessionId || pending.userId !== userId || pending.actionId !== action?.id) {
    throw Object.assign(new Error('This device approval does not belong to this action.'), {
      code: 'WEBAUTHN_ACTION_MISMATCH',
    })
  }

  const credentials = await getCredentials(userId)
  const storedCredential = credentials.find((credential) => credential.credentialID === response?.id)
  if (!storedCredential) {
    throw Object.assign(new Error('This device is not registered. Set it up again in Settings.'), {
      code: 'DEVICE_NOT_REGISTERED',
    })
  }

  try {
    const verification = await verifyFn({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: 'required' },
      credential: {
        id: storedCredential.credentialID,
        publicKey: fromBase64Url(storedCredential.publicKey),
        counter: storedCredential.counter,
        transports: storedCredential.transports,
      },
    })

    if (!verification.verified) throw new Error('The device could not verify you. Please try again.')
    const newCounter = verification.authenticationInfo.newCounter
    if (newCounter !== 0 && storedCredential.counter !== 0 && newCounter <= storedCredential.counter) {
      throw Object.assign(new Error('This device response was already used. Please try again.'), {
        code: 'WEBAUTHN_COUNTER_ROLLBACK',
      })
    }

    const store = await readCredentialStore()
    const updated = (store[userId] || []).map((credential) =>
      credential.credentialID === storedCredential.credentialID
        ? { ...credential, counter: newCounter }
        : credential,
    )
    store[userId] = updated
    await writeCredentialStore(store)
    recordDeviceApproval(action, userId, sessionId, pending.detailsHash)
    return { approved: true }
  } catch (error) {
    throw cleanError(error)
  }
}

export async function getPracticeOptions(userId) {
  const credentials = await getCredentials(userId)
  if (credentials.length === 0) {
    throw Object.assign(new Error('No device is set up. Set up this device first.'), {
      code: 'DEVICE_NOT_REGISTERED',
    })
  }

  const practice = {
    id: 'voicepay-practice',
    type: 'practice',
    details: { amount: '0', recipient: 'practice', product: 'device-check' },
  }
  const challenge = createActionChallenge(practice, toBase64Url(randomBytes(32)))
  practiceChallenges.set(userId, {
    challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  })

  return generateAuthenticationOptions({
    rpID: config.rpId,
    challenge,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialID,
      transports: credential.transports,
    })),
    userVerification: 'required',
  })
}

export async function verifyPractice(userId, response, verifyFn = verifyAuthenticationResponse) {
  const challenge = practiceChallenges.get(userId)
  practiceChallenges.delete(userId)
  if (!challenge || challenge.expiresAt <= Date.now()) {
    throw Object.assign(new Error('The practice check expired. Please try again.'), {
      code: 'WEBAUTHN_CHALLENGE_EXPIRED',
    })
  }

  const credentials = await getCredentials(userId)
  const storedCredential = credentials.find((credential) => credential.credentialID === response?.id)
  if (!storedCredential) {
    throw Object.assign(new Error('This device is not registered. Set it up again in Settings.'), {
      code: 'DEVICE_NOT_REGISTERED',
    })
  }

  try {
    const verification = await verifyFn({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: 'required' },
      credential: {
        id: storedCredential.credentialID,
        publicKey: fromBase64Url(storedCredential.publicKey),
        counter: storedCredential.counter,
        transports: storedCredential.transports,
      },
    })

    if (!verification.verified) throw new Error('The device could not verify you. Please try again.')
    const newCounter = verification.authenticationInfo.newCounter
    if (newCounter !== 0 && storedCredential.counter !== 0 && newCounter <= storedCredential.counter) {
      throw Object.assign(new Error('This device response was already used. Please try again.'), {
        code: 'WEBAUTHN_COUNTER_ROLLBACK',
      })
    }

    const store = await readCredentialStore()
    store[userId] = (store[userId] || []).map((credential) =>
      credential.credentialID === storedCredential.credentialID
        ? { ...credential, counter: newCounter }
        : credential,
    )
    await writeCredentialStore(store)
    return { approved: true, practice: true }
  } catch (error) {
    throw cleanError(error, 'The practice device check did not work. Please try again.')
  }
}

export function clearWebAuthnState() {
  registrationChallenges.clear()
  approvalChallenges.clear()
  practiceChallenges.clear()
}

export function expireApprovalForTest(actionId) {
  const challenge = approvalChallenges.get(actionId)
  if (challenge) challenge.expiresAt = Date.now() - 1
}

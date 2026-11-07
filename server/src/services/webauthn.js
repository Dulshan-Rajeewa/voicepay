import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { config, isDeviceAuthRequired } from '../config.js'
import {
  getAndConsumeChallenge,
  getCredentials,
  removeCredentials as removeStoredCredentials,
  saveChallenge,
  saveCredential,
  updateCredentialCounter,
} from '../db/index.js'
import {
  getActionDetailsHash,
  getPendingAction,
  recordDeviceApproval,
} from './pending.js'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const USER_COOKIE = 'voicepay-user-id'
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
  const secure = config.isProduction ? '; Secure' : ''
  response.append(
    'Set-Cookie',
    `${USER_COOKIE}=${userId}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${secure}`,
  )
  return userId
}

function cleanError(error, fallback = 'Device confirmation could not be completed.') {
  const clean = new Error(error?.message || fallback)
  clean.code = error?.code || mapWebAuthnErrorCode(error)
  clean.publicMessage = error?.publicMessage || friendlyWebAuthnMessage(clean.code, clean.message, fallback)
  return clean
}

function mapWebAuthnErrorCode(error) {
  const message = String(error?.message || '').toLowerCase()
  if (message.includes('origin')) return 'ORIGIN_MISMATCH'
  if (message.includes('rp id') || message.includes('rp_id') || message.includes('relying party')) return 'RPID_MISMATCH'
  if (message.includes('challenge')) return 'CHALLENGE_NOT_FOUND'
  return 'WEBAUTHN_ERROR'
}

function friendlyWebAuthnMessage(code, message, fallback) {
  if (code === 'ORIGIN_MISMATCH') return 'This site address is not allowed. Open VoicePay at its stable production address.'
  if (code === 'RPID_MISMATCH') return 'This device is linked to a different site address. Open VoicePay at its stable production address and register again.'
  if (code === 'CHALLENGE_NOT_FOUND') return 'The device check has expired. Press the setup button again.'
  if (code === 'NO_SESSION') return 'Your secure session is missing. Refresh VoicePay and try again.'
  if (code === 'DEVICE_NOT_REGISTERED') return message
  return fallback
}

function getRequestOrigin(request) {
  const headerOrigin = request?.get?.('origin')
  if (headerOrigin) return headerOrigin.replace(/\/+$/, '')
  if (!request) return null
  const protocol = request.protocol || 'https'
  const host = request.get('host')
  return host ? `${protocol}://${host}` : null
}

export function getWebAuthnContext(request) {
  const origin = getRequestOrigin(request)
  if (!request) {
    return { origin: config.origins[0], rpId: config.rpId, origins: config.origins }
  }
  if (!origin || !config.origins.includes(origin)) {
    throw Object.assign(new Error('The request origin is not allowed.'), {
      code: 'ORIGIN_MISMATCH',
      publicMessage: 'This site address is not allowed. Open VoicePay at its stable production address.',
    })
  }
  const hostname = new URL(origin).hostname
  if (hostname === 'vercel.app' || hostname.endsWith('.vercel.app') && hostname.split('.').length < 3) {
    throw Object.assign(new Error('A public-suffix RP ID is not allowed.'), {
      code: 'RPID_MISMATCH',
      publicMessage: 'Use your stable Vercel production address, not a preview address.',
    })
  }
  return { origin, rpId: hostname, origins: [origin] }
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

export async function getRegistrationOptions(userId, request) {
  const webAuthn = getWebAuthnContext(request)
  const credentials = await getCredentials(userId)
  const challengeBytes = randomBytes(32)
  const challenge = toBase64Url(challengeBytes)
  await saveChallenge(`registration:${userId}`, {
    userId,
    type: 'registration',
    challenge,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  })

  return generateRegistrationOptions({
    rpName: config.rpName,
    rpID: webAuthn.rpId,
    userName: userId,
    userID: Buffer.from(userId),
    challenge: challengeBytes,
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
  request,
) {
  const webAuthn = getWebAuthnContext(request)
  const challengeEntry = await getAndConsumeChallenge(`registration:${userId}`)
  if (!challengeEntry || new Date(challengeEntry.expiresAt).getTime() <= Date.now()) {
    throw Object.assign(new Error('Registration has expired. Please start again.'), {
      code: 'WEBAUTHN_CHALLENGE_EXPIRED',
      publicMessage: 'The device setup has expired. Press Set up this device again.',
    })
  }

  try {
    const verification = await verifyFn({
      response,
      expectedChallenge: challengeEntry.challenge,
      expectedOrigin: webAuthn.origins,
      expectedRPID: webAuthn.rpId,
      requireUserVerification: true,
    })

    if (!verification.verified) {
      throw new Error('The device could not verify you. Please try again.')
    }

    const credential = verification.registrationInfo.credential
    await saveCredential(userId, {
      credentialID: credential.id,
      publicKey: toBase64Url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports || response.response?.transports || [],
      createdAt: new Date().toISOString(),
      deviceLabel: String(deviceLabel).trim().slice(0, 80) || 'This device',
    })
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
  await removeStoredCredentials(userId)
  return { registered: false }
}

export async function getApprovalOptions(actionId, sessionId, userId, request) {
  const webAuthn = getWebAuthnContext(request)
  const action = await getPendingAction(actionId, sessionId)
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
  await saveChallenge(`approval:${action.id}`, {
    type: 'approval',
    userId,
    challenge,
    actionId: action.id,
    sessionId,
    userId,
    detailsHash: getActionDetailsHash(action),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  })

  return generateAuthenticationOptions({
    rpID: webAuthn.rpId,
    challenge: fromBase64Url(challenge),
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
  request,
) {
  const webAuthn = getWebAuthnContext(request)
  const pending = await getAndConsumeChallenge(`approval:${actionId}`)
  const action = await getPendingAction(actionId, sessionId)

  if (!pending || new Date(pending.expiresAt).getTime() <= Date.now()) {
    throw Object.assign(new Error('Device approval has expired. Please try again.'), {
      code: 'WEBAUTHN_CHALLENGE_EXPIRED',
      publicMessage: 'The device check has expired. Press the button again.',
    })
  }
  if (pending.sessionId !== sessionId || pending.userId !== userId || pending.actionId !== action?.id) {
    throw Object.assign(new Error('This device approval does not belong to this action.'), {
      code: 'WEBAUTHN_ACTION_MISMATCH',
      publicMessage: 'This device check belongs to a different payment. Start the check again.',
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
      expectedOrigin: webAuthn.origins,
      expectedRPID: webAuthn.rpId,
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

    await updateCredentialCounter(userId, storedCredential.credentialID, newCounter)
    await recordDeviceApproval(action, userId, sessionId, pending.detailsHash)
    return { approved: true }
  } catch (error) {
    throw cleanError(error)
  }
}

export async function getPracticeOptions(userId, request) {
  const webAuthn = getWebAuthnContext(request)
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
  await saveChallenge(`practice:${userId}`, {
    userId,
    type: 'practice',
    challenge,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  })

  return generateAuthenticationOptions({
    rpID: webAuthn.rpId,
    challenge: fromBase64Url(challenge),
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialID,
      transports: credential.transports,
    })),
    userVerification: 'required',
  })
}

export async function verifyPractice(userId, response, verifyFn = verifyAuthenticationResponse, request) {
  const webAuthn = getWebAuthnContext(request)
  const challenge = await getAndConsumeChallenge(`practice:${userId}`)
  if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now()) {
    throw Object.assign(new Error('The practice check expired. Please try again.'), {
      code: 'WEBAUTHN_CHALLENGE_EXPIRED',
      publicMessage: 'The practice check has expired. Press Practice now again.',
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
      expectedOrigin: webAuthn.origins,
      expectedRPID: webAuthn.rpId,
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

    await updateCredentialCounter(userId, storedCredential.credentialID, newCounter)
    return { approved: true, practice: true }
  } catch (error) {
    throw cleanError(error, 'The practice device check did not work. Please try again.')
  }
}

export function clearWebAuthnState() {
}

export function expireApprovalForTest(actionId) {
  return getAndConsumeChallenge(`approval:${actionId}`)
}

export function getPublicWebAuthnConfig(request) {
  const webAuthn = getWebAuthnContext(request)
  return {
    rpId: webAuthn.rpId,
    expectedOrigins: config.origins,
    currentOrigin: webAuthn.origin,
    storage: config.storageDriver,
  }
}

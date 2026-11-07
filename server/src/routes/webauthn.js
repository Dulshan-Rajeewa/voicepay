import { Router } from 'express'
import {
  getOrCreateUserId,
  getRegistrationOptions,
  verifyRegistration,
  getStatus,
  removeCredentials,
  getApprovalOptions,
  verifyApproval,
  getPracticeOptions,
  verifyPractice,
  getPublicWebAuthnConfig,
} from '../services/webauthn.js'
import { sendError } from '../http.js'

const router = Router()

router.get('/config', async (request, response) => {
  try {
    response.json(getPublicWebAuthnConfig(request))
  } catch (error) {
    sendError(response, error, 'VoicePay site settings are not ready. Open the stable production address and try again.')
  }
})

function getSessionId(request) {
  return request.get('x-session-id') || request.body?.sessionId
}

function missingSessionError() {
  return Object.assign(new Error('A secure session is required. Refresh VoicePay and try again.'), {
    code: 'NO_SESSION',
    publicMessage: 'Your secure session is missing. Refresh VoicePay and try again.',
  })
}

router.get('/status', async (request, response) => {
  try {
    const userId = getOrCreateUserId(request, response)
    response.json(await getStatus(userId))
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/register/options', async (request, response) => {
  try {
    const userId = getOrCreateUserId(request, response)
    response.json(await getRegistrationOptions(userId, request))
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/register/verify', async (request, response) => {
  try {
    const userId = getOrCreateUserId(request, response)
    response.json(await verifyRegistration(
      userId,
      request.body?.response,
      request.body?.deviceLabel,
      undefined,
      request,
    ))
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/approve/options', async (request, response) => {
  try {
    const sessionId = getSessionId(request)
    if (!sessionId) throw missingSessionError()
    const userId = getOrCreateUserId(request, response)
    response.json(await getApprovalOptions(request.body?.actionId, sessionId, userId, request))
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/approve/verify', async (request, response) => {
  try {
    const sessionId = getSessionId(request)
    if (!sessionId) throw missingSessionError()
    const userId = getOrCreateUserId(request, response)
    response.json(await verifyApproval(
      request.body?.actionId,
      sessionId,
      userId,
      request.body?.response,
      undefined,
      request,
    ))
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/practice/options', async (request, response) => {
  try {
    const userId = getOrCreateUserId(request, response)
    response.json(await getPracticeOptions(userId, request))
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/practice/verify', async (request, response) => {
  try {
    const userId = getOrCreateUserId(request, response)
    response.json(await verifyPractice(userId, request.body?.response, undefined, request))
  } catch (error) {
    sendError(response, error)
  }
})

router.delete('/credentials', async (request, response) => {
  try {
    const userId = getOrCreateUserId(request, response)
    response.json(await removeCredentials(userId))
  } catch (error) {
    sendError(response, error)
  }
})

export default router

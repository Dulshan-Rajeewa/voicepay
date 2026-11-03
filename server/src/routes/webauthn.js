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
} from '../services/webauthn.js'
import { sendError } from '../http.js'

const router = Router()

function getSessionId(request) {
  return request.get('x-session-id') || request.body?.sessionId
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
    response.json(await getRegistrationOptions(userId))
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
    ))
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/approve/options', async (request, response) => {
  try {
    const sessionId = getSessionId(request)
    if (!sessionId) throw new Error('A session ID is required.')
    const userId = getOrCreateUserId(request, response)
    response.json(await getApprovalOptions(request.body?.actionId, sessionId, userId))
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/approve/verify', async (request, response) => {
  try {
    const sessionId = getSessionId(request)
    if (!sessionId) throw new Error('A session ID is required.')
    const userId = getOrCreateUserId(request, response)
    response.json(await verifyApproval(
      request.body?.actionId,
      sessionId,
      userId,
      request.body?.response,
    ))
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/practice/options', async (request, response) => {
  try {
    const userId = getOrCreateUserId(request, response)
    response.json(await getPracticeOptions(userId))
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/practice/verify', async (request, response) => {
  try {
    const userId = getOrCreateUserId(request, response)
    response.json(await verifyPractice(userId, request.body?.response))
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

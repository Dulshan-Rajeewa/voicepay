import { Router } from 'express'
import { getOrCreateUserId } from '../services/webauthn.js'
import { approveWithPin, getPinStatus, setPin } from '../services/pin.js'
import { sendError } from '../http.js'

const router = Router()
const sessionId = (request) => request.get('x-session-id') || request.body?.sessionId

router.get('/status', async (request, response) => {
  try { response.json(await getPinStatus(getOrCreateUserId(request, response))) }
  catch (error) { sendError(response, error, 'PIN status is not available.') }
})

router.post('/set', async (request, response) => {
  try {
    const userId = getOrCreateUserId(request, response)
    response.json(await setPin(userId, request.body?.pin))
  } catch (error) { sendError(response, error, 'The PIN could not be saved.') }
})

router.post('/change', async (request, response) => {
  try {
    const userId = getOrCreateUserId(request, response)
    response.json(await setPin(userId, request.body?.pin, request.body?.currentPin))
  } catch (error) { sendError(response, error, 'The PIN could not be changed.') }
})

router.post('/approve', async (request, response) => {
  try {
    const currentSession = sessionId(request)
    if (!currentSession) throw Object.assign(new Error('A secure session is required.'), { code: 'NO_SESSION' })
    const userId = getOrCreateUserId(request, response)
    response.json(await approveWithPin(userId, currentSession, request.body?.actionId, request.body?.pin))
  } catch (error) { sendError(response, error, 'PIN approval could not be completed.') }
})

export default router

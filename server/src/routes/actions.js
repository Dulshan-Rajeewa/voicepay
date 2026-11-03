import { Router } from 'express'
import {
  cancelPendingAction,
  confirmPendingAction,
  getPendingAction,
  logCancelledAction,
  toPublicPendingAction,
} from '../services/pending.js'
import { sendError } from '../http.js'

const router = Router()

function getSessionId(request) {
  return request.get('x-session-id') || request.body?.sessionId
}

router.post('/confirm', async (request, response) => {
  const { actionId, confirmation } = request.body ?? {}
  const sessionId = getSessionId(request)

  try {
    if (!sessionId) throw new Error('A session ID is required.')
    if (typeof actionId !== 'string' || !(confirmation === true || ['confirm', 'yes', 'confirmed'].includes(String(confirmation).toLowerCase()))) {
      const error = new Error('A valid confirmation is required.')
      error.statusCode = 400
      throw error
    }
    const action = await confirmPendingAction(
      actionId,
      confirmation,
      undefined,
      sessionId,
    )
    response.json({ action: toPublicPendingAction(action) })
  } catch (error) {
    sendError(response, error, 'The payment could not be confirmed.')
  }
})

router.post('/cancel', async (request, response) => {
  const { actionId } = request.body ?? {}
  const sessionId = getSessionId(request)

  try {
    if (!sessionId) throw new Error('A session ID is required.')
    const action = await cancelPendingAction(actionId, sessionId)
    await logCancelledAction(action)
    response.json({ action: toPublicPendingAction(action) })
  } catch (error) {
    sendError(response, error)
  }
})

router.get('/actions/:id', async (request, response) => {
  const sessionId = getSessionId(request)
  if (!sessionId) {
    response.status(400).json({ error: 'A session ID is required.' })
    return
  }

  let action
  try {
    action = await getPendingAction(request.params.id, sessionId)
  } catch {
    response.status(404).json({ error: 'Pending action was not found.' })
    return
  }

  if (!action) {
    response.status(404).json({ error: 'Pending action was not found.' })
    return
  }

  response.json({ action: toPublicPendingAction(action) })
})

export default router

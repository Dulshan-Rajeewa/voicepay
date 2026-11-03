import { Router } from 'express'
import {
  cancelPendingAction,
  confirmPendingAction,
  getPendingAction,
  logCancelledAction,
  toPublicPendingAction,
} from '../services/pending.js'

const router = Router()

function sendError(response, error) {
  response.status(400).json({ error: error.message, code: error.code })
}

function getSessionId(request) {
  return request.get('x-session-id') || request.body?.sessionId
}

router.post('/confirm', async (request, response) => {
  const { actionId, confirmation } = request.body ?? {}
  const sessionId = getSessionId(request)

  try {
    if (!sessionId) throw new Error('A session ID is required.')
    const action = await confirmPendingAction(
      actionId,
      confirmation,
      undefined,
      sessionId,
    )
    response.json({ action: toPublicPendingAction(action) })
  } catch (error) {
    sendError(response, error)
  }
})

router.post('/cancel', async (request, response) => {
  const { actionId } = request.body ?? {}
  const sessionId = getSessionId(request)

  try {
    if (!sessionId) throw new Error('A session ID is required.')
    const action = cancelPendingAction(actionId, sessionId)
    await logCancelledAction(action)
    response.json({ action: toPublicPendingAction(action) })
  } catch (error) {
    sendError(response, error)
  }
})

router.get('/actions/:id', (request, response) => {
  const sessionId = getSessionId(request)
  if (!sessionId) {
    response.status(400).json({ error: 'A session ID is required.' })
    return
  }

  let action
  try {
    action = getPendingAction(request.params.id, sessionId)
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

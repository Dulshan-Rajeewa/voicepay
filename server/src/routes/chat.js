import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { chat } from '../services/agent.js'
import { sendError } from '../http.js'

const router = Router()

router.post('/chat', async (request, response) => {
  const sessionId =
    request.get('x-session-id') ||
    request.body?.sessionId ||
    randomUUID()

  try {
    if (typeof request.body?.message !== 'string' || request.body.message.trim().length === 0 || request.body.message.length > 2000) {
      const error = new Error('Please enter a message up to 2,000 characters.')
      error.statusCode = 400
      throw error
    }
    const result = await chat({
      sessionId,
      message: request.body?.message,
    })
    response.json({ sessionId, ...result })
  } catch (error) {
    sendError(response, error, 'VoicePay could not process that message.')
  }
})

export default router

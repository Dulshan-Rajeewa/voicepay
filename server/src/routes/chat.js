import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { chat } from '../services/agent.js'

const router = Router()

router.post('/chat', async (request, response) => {
  const sessionId =
    request.get('x-session-id') ||
    request.body?.sessionId ||
    randomUUID()

  try {
    const result = await chat({
      sessionId,
      message: request.body?.message,
    })
    response.json({ sessionId, ...result })
  } catch (error) {
    response.status(error.statusCode || 400).json({ error: error.message })
  }
})

export default router

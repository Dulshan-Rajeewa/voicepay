import cors from 'cors'
import express from 'express'
import { config } from './config.js'
import actionsRouter from './routes/actions.js'
import chatRouter from './routes/chat.js'

const app = express()

app.use(cors({ origin: config.clientOrigin }))
app.use(express.json())
app.use('/api', actionsRouter)
app.use('/api', chatRouter)

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'voicepay-server' })
})

app.listen(config.port, () => {
  console.log(`VoicePay server listening on http://localhost:${config.port}`)
})

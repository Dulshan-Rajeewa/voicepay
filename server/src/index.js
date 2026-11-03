import cors from 'cors'
import express from 'express'
import { config } from './config.js'
import actionsRouter from './routes/actions.js'
import chatRouter from './routes/chat.js'
import webauthnRouter from './routes/webauthn.js'

const app = express()

app.use(cors({ origin: config.origins, credentials: true }))
app.use(express.json())
app.use('/api', actionsRouter)
app.use('/api', chatRouter)
app.use('/api/webauthn', webauthnRouter)

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'voicepay-server' })
})

app.listen(config.port, () => {
  console.log(`VoicePay server listening on http://localhost:${config.port}`)
  if (!config.requireDeviceAuth) {
    console.warn('WARNING: REQUIRE_DEVICE_AUTH=false is DEMO ONLY. Never use this setting in production.')
  }
})

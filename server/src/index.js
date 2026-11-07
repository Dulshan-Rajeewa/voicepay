import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import actionsRouter from './routes/actions.js'
import chatRouter from './routes/chat.js'
import webauthnRouter from './routes/webauthn.js'
import pinRouter from './routes/pin.js'

const app = express()
app.set('trust proxy', 1)

if (!config.isProduction) {
  app.use(cors({ origin: config.origins, credentials: true }))
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      mediaSrc: ["'self'", 'blob:'],
    },
  },
}))
app.use(express.json({ limit: '100kb' }))

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
})
app.use('/api/chat', apiLimiter)
app.use('/api/webauthn', apiLimiter)
app.use('/api/confirm', apiLimiter)
app.use('/api', actionsRouter)
app.use('/api', chatRouter)
app.use('/api/webauthn', webauthnRouter)
app.use('/api/pin', apiLimiter, pinRouter)

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    storage: config.storageDriver,
    paypalConfigured: config.useMockPaypal || Boolean(config.paypalClientId && config.paypalClientSecret),
    time: new Date().toISOString(),
  })
})

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'API route not found.' })
})

if (config.isProduction) {
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist')
  app.use(express.static(clientDist, { maxAge: '1d', index: 'index.html' }))
  app.use((request, response, next) => {
    if (request.method !== 'GET' || request.path.startsWith('/api/')) return next()
    response.sendFile(path.join(clientDist, 'index.html'))
  })
}

app.use((error, _request, response, _next) => {
  if (config.isProduction) {
    console.error('Request failed.')
  } else {
    console.error('Request failed:', error.message)
  }
  response.status(error.statusCode || 500).json({
    error: config.isProduction ? 'Something went wrong. Please try again.' : error.message,
  })
})

if (!config.isVercel) {
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`VoicePay server listening on port ${config.port}`)
    if (!config.requireDeviceAuth) {
      console.warn('WARNING: REQUIRE_DEVICE_AUTH=false is DEMO ONLY. Never use this setting in production.')
    }
  })
}

export default app

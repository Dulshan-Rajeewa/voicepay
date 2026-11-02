import 'dotenv/config'

const useMockPaypal = process.env.USE_MOCK_PAYPAL === 'true'

const requiredEnvironment = useMockPaypal
  ? []
  : ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']

const missingEnvironment = requiredEnvironment.filter(
  (name) => !process.env[name]?.trim(),
)

if (missingEnvironment.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missingEnvironment.join(
      ', ',
    )}. Add them to server/.env, or set USE_MOCK_PAYPAL=true for local development.`,
  )
}

const maxPaymentUsd = Number(process.env.MAX_PAYMENT_USD ?? '100')

if (!Number.isFinite(maxPaymentUsd) || maxPaymentUsd <= 0) {
  throw new Error('MAX_PAYMENT_USD must be a positive number.')
}

export const config = Object.freeze({
  port: Number(process.env.PORT ?? '3001'),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  useMockPaypal,
  paypalBaseUrl:
    process.env.PAYPAL_BASE_URL ?? 'https://api-m.sandbox.paypal.com',
  transactionLogPath: process.env.TRANSACTION_LOG_PATH ?? '',
  maxPaymentUsd,
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash',
  paypalClientId: process.env.PAYPAL_CLIENT_ID ?? '',
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
  paypalVaultId: process.env.PAYPAL_VAULT_ID ?? '',
})

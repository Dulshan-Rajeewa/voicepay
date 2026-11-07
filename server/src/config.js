import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') })
dotenv.config()

const useMockPaypal = process.env.USE_MOCK_PAYPAL === 'true'
const isProduction = process.env.NODE_ENV === 'production'
const isVercel = process.env.VERCEL === '1'
const paypalBaseUrl = (process.env.PAYPAL_BASE_URL ?? 'https://api-m.sandbox.paypal.com').replace(/\/+$/, '')
const allowDemoMode = process.env.ALLOW_DEMO_MODE === 'true'

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

const origins = (process.env.ALLOWED_ORIGINS ?? process.env.ORIGIN ?? process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .map((origin) => origin.replace(/\/+$/, ''))
  .filter(Boolean)

const requireDeviceAuth = process.env.REQUIRE_DEVICE_AUTH !== 'false'
const allowPinFallback = process.env.ALLOW_PIN_FALLBACK !== 'false'
const storageDriver = process.env.STORAGE_DRIVER ?? 'file'

if (!['file', 'firestore'].includes(storageDriver)) {
  throw new Error('STORAGE_DRIVER must be either file or firestore.')
}

if (isVercel && storageDriver !== 'firestore') {
  throw new Error('Vercel deployments must use STORAGE_DRIVER=firestore because local files and memory are not persistent.')
}

if (storageDriver === 'firestore' &&
  !process.env.FIREBASE_SERVICE_ACCOUNT_B64?.trim() &&
  !process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() &&
  !process.env.FIRESTORE_EMULATOR_HOST?.trim()) {
  throw new Error(
    'FIREBASE_SERVICE_ACCOUNT_B64 or GOOGLE_APPLICATION_CREDENTIALS is required when STORAGE_DRIVER=firestore.',
  )
}

if (isProduction && paypalBaseUrl !== 'https://api-m.sandbox.paypal.com') {
  throw new Error('Production deployments must use the PayPal Sandbox API URL: https://api-m.sandbox.paypal.com.')
}

if (isProduction && !requireDeviceAuth && !allowDemoMode) {
  throw new Error('REQUIRE_DEVICE_AUTH=false is blocked in production unless ALLOW_DEMO_MODE=true is explicitly set.')
}

const appBaseUrl = (process.env.APP_BASE_URL ?? (isProduction ? '' : `http://localhost:${process.env.PORT ?? '3001'}`)).replace(/\/+$/, '')
if (isProduction && !/^https:\/\//i.test(appBaseUrl)) {
  throw new Error('APP_BASE_URL must be an HTTPS URL in production.')
}

export function isDeviceAuthRequired() {
  return process.env.REQUIRE_DEVICE_AUTH !== 'false'
}

export const config = Object.freeze({
  port: Number(process.env.PORT ?? '3001'),
  isProduction,
  isVercel,
  appBaseUrl,
  allowDemoMode,
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  origins,
  rpId: process.env.RP_ID ?? 'localhost',
  rpName: process.env.RP_NAME ?? 'VoicePay',
  requireDeviceAuth,
  allowPinFallback,
  storageDriver,
  credentialStorePath: process.env.CREDENTIAL_STORE_PATH ?? '',
  useMockPaypal,
  paypalBaseUrl,
  transactionLogPath: process.env.TRANSACTION_LOG_PATH ?? '',
  pendingActionStorePath: process.env.PENDING_ACTION_STORE_PATH ?? '',
  maxPaymentUsd,
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash',
  paypalClientId: process.env.PAYPAL_CLIENT_ID ?? '',
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
  paypalVaultId: process.env.PAYPAL_VAULT_ID ?? '',
})

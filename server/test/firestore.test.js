import { test } from 'node:test'

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST)

test('Firestore driver suite', {
  skip: !emulatorAvailable
    ? 'Skipped: set FIRESTORE_EMULATOR_HOST and FIREBASE_PROJECT_ID to run Firestore emulator tests.'
    : false,
}, async () => {
  process.env.STORAGE_DRIVER = 'firestore'
  process.env.FIREBASE_PROJECT_ID ||= 'voicepay-emulator'
  const { checkConnection } = await import('../src/db/index.js')
  if (!(await checkConnection())) throw new Error('Firestore emulator check failed.')
})

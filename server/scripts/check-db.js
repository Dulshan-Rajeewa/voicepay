import 'dotenv/config'
import { checkConnection, getStorageDriver } from '../src/db/index.js'

try {
  const ok = await checkConnection()
  if (!ok) throw new Error('The database test document was not read back correctly.')
  console.log(`OK: ${getStorageDriver()} storage can write, read, and delete a test document.`)
} catch (error) {
  console.error(`FAIL: ${error.message}`)
  process.exitCode = 1
}

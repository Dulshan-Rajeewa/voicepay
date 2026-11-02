import 'dotenv/config'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dataDirectory = fileURLToPath(new URL('../src/data/', import.meta.url))
const contactsPath = path.join(dataDirectory, 'contacts.json')
const transactionsPath = path.join(dataDirectory, 'transactions.json')

const contacts = [
  {
    nickname: 'nimal',
    name: 'Nimal',
    email: process.env.CONTACT_NIMAL_EMAIL || 'nimal-sandbox@example.com',
  },
  {
    nickname: 'sara',
    name: 'Sara',
    email: process.env.CONTACT_SARA_EMAIL || 'sara-sandbox@example.com',
  },
  {
    nickname: 'alex',
    name: 'Alex',
    email: process.env.CONTACT_ALEX_EMAIL || 'alex-sandbox@example.com',
  },
]

await mkdir(dataDirectory, { recursive: true })
await writeFile(contactsPath, `${JSON.stringify(contacts, null, 2)}\n`)
await unlink(transactionsPath).catch((error) => {
  if (error.code !== 'ENOENT') throw error
})

console.log('VoicePay demo data reset. Three contacts are ready and transactions are empty.')

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const contactsPath = fileURLToPath(new URL('../data/contacts.json', import.meta.url))
const defaultContacts = [
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

function normalize(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

function distance(left, right) {
  const matrix = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, column) =>
      row === 0 ? column : column === 0 ? row : 0,
    ),
  )

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      matrix[row][column] =
        left[row - 1] === right[column - 1]
          ? matrix[row - 1][column - 1]
          : Math.min(
              matrix[row - 1][column] + 1,
              matrix[row][column - 1] + 1,
              matrix[row - 1][column - 1] + 1,
            )
    }
  }

  return matrix[left.length][right.length]
}

async function readContacts() {
  try {
    const contents = await readFile(contactsPath, 'utf8')
    const contacts = JSON.parse(contents)
    if (Array.isArray(contacts)) {
      return contacts
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error('Contacts could not be read.')
    }
  }

  await writeContacts(defaultContacts)
  return defaultContacts
}

async function writeContacts(contacts) {
  try {
    await mkdir(path.dirname(contactsPath), { recursive: true })
    await writeFile(contactsPath, `${JSON.stringify(contacts, null, 2)}\n`)
  } catch {
    throw new Error('Contacts could not be saved.')
  }
}

export async function listContacts() {
  return readContacts()
}

export async function addContact({ nickname, name, email }) {
  if (
    typeof nickname !== 'string' ||
    !nickname.trim() ||
    typeof name !== 'string' ||
    !name.trim() ||
    typeof email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    throw new Error('A contact needs a nickname, name, and valid email address.')
  }

  const contacts = await readContacts()
  const normalizedNickname = normalize(nickname)
  const duplicate = contacts.find(
    (contact) => normalize(contact.nickname) === normalizedNickname,
  )

  if (duplicate) {
    throw new Error(`A contact named ${nickname.trim()} already exists.`)
  }

  const contact = {
    nickname: nickname.trim(),
    name: name.trim(),
    email: email.trim(),
  }
  contacts.push(contact)
  await writeContacts(contacts)
  return contact
}

export async function findContact(query) {
  if (typeof query !== 'string' || !query.trim()) {
    return { contact: null, matches: [], ambiguous: false }
  }

  const contacts = await readContacts()
  const normalizedQuery = normalize(query)
  const exact = contacts.filter(
    (contact) =>
      normalize(contact.nickname) === normalizedQuery ||
      normalize(contact.name) === normalizedQuery,
  )

  if (exact.length === 1) {
    return { contact: exact[0], matches: exact, ambiguous: false }
  }

  const candidates = contacts
    .map((contact) => {
      const nickname = normalize(contact.nickname)
      const name = normalize(contact.name)
      return {
        contact,
        score: Math.min(
          distance(normalizedQuery, nickname),
          distance(normalizedQuery, name),
        ),
      }
    })
    .filter(({ score }) => score <= Math.max(2, Math.floor(normalizedQuery.length / 3)))
    .sort((left, right) => left.score - right.score)

  const bestScore = candidates[0]?.score
  const matches = candidates
    .filter(({ score }) => score === bestScore)
    .map(({ contact }) => contact)

  return {
    contact: matches.length === 1 ? matches[0] : null,
    matches,
    ambiguous: matches.length > 1,
  }
}

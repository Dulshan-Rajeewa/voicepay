import { addContact as saveContact, listContacts as readContacts } from '../db/index.js'

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

export async function listContacts(userId = 'default') {
  return readContacts(userId)
}

export async function addContact({ nickname, name, email }, userId = 'default') {
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

  const contacts = await listContacts(userId)
  const normalizedNickname = normalize(nickname)
  if (contacts.some((contact) => normalize(contact.nickname) === normalizedNickname)) {
    throw new Error(`A contact named ${nickname.trim()} already exists.`)
  }

  return saveContact(userId, {
    nickname: nickname.trim(),
    name: name.trim(),
    email: email.trim(),
  })
}

export async function findContact(query, userId = 'default') {
  if (typeof query !== 'string' || !query.trim()) {
    return { contact: null, matches: [], ambiguous: false }
  }

  const contacts = await listContacts(userId)
  const normalizedQuery = normalize(query)
  const exact = contacts.filter(
    (contact) =>
      normalize(contact.nickname) === normalizedQuery ||
      normalize(contact.name) === normalizedQuery,
  )

  if (exact.length === 1) return { contact: exact[0], matches: exact, ambiguous: false }

  const candidates = contacts
    .map((contact) => ({
      contact,
      score: Math.min(
        distance(normalizedQuery, normalize(contact.nickname)),
        distance(normalizedQuery, normalize(contact.name)),
      ),
    }))
    .filter(({ score }) => score <= Math.max(2, Math.floor(normalizedQuery.length / 3)))
    .sort((left, right) => left.score - right.score)

  const bestScore = candidates[0]?.score
  const matches = candidates.filter(({ score }) => score === bestScore).map(({ contact }) => contact)
  return { contact: matches.length === 1 ? matches[0] : null, matches, ambiguous: matches.length > 1 }
}

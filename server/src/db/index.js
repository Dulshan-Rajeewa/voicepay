import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { config } from '../config.js'

const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url))
const defaultFiles = {
  users: path.join(dataDirectory, 'users.json'),
  contacts: path.join(dataDirectory, 'contacts.json'),
  credentials: config.credentialStorePath || path.join(dataDirectory, 'credentials.json'),
  transactions: config.transactionLogPath || path.join(dataDirectory, 'transactions.json'),
  pendingActions: config.pendingActionStorePath || path.join(dataDirectory, 'pending-actions.json'),
  challenges: path.join(dataDirectory, 'webauthn-challenges.json'),
  sessions: path.join(dataDirectory, 'sessions.json'),
  pins: path.join(dataDirectory, 'pins.json'),
}

const defaultContacts = [
  { nickname: 'nimal', name: 'Nimal', email: process.env.CONTACT_NIMAL_EMAIL || 'nimal-sandbox@example.com' },
  { nickname: 'sara', name: 'Sara', email: process.env.CONTACT_SARA_EMAIL || 'sara-sandbox@example.com' },
  { nickname: 'alex', name: 'Alex', email: process.env.CONTACT_ALEX_EMAIL || 'alex-sandbox@example.com' },
]

let firestore
let fileWriteLock = Promise.resolve()

function isFirestore() {
  return process.env.STORAGE_DRIVER === 'firestore'
}

function assertFirestoreConfig() {
  if (!isFirestore()) return
  if (firestore) return
  try {
    if (!getApps().length) {
      const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_B64?.trim()
      if (encoded) {
        initializeApp({ credential: cert(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))) })
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
        initializeApp()
      } else if (process.env.FIRESTORE_EMULATOR_HOST?.trim()) {
        initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'voicepay-emulator' })
      } else {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 or GOOGLE_APPLICATION_CREDENTIALS is required when STORAGE_DRIVER=firestore.')
      }
    }
    firestore = getFirestore()
  } catch (error) {
    if (error.message.includes('required when STORAGE_DRIVER')) throw error
    throw new Error('Firebase Admin could not be initialized. Check the Firestore service-account configuration.')
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error('Local storage could not be read.')
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function getFileState() {
  const entries = await Promise.all(Object.entries(defaultFiles).map(async ([key, file]) => [
    key,
    await readJson(file, key === 'contacts' ? defaultContacts : {}),
  ]))
  return Object.fromEntries(entries)
}

async function updateFileState(mutator) {
  const operation = fileWriteLock.then(async () => {
    const state = await getFileState()
    const before = Object.fromEntries(Object.keys(defaultFiles).map((key) => [key, JSON.stringify(state[key])]))
    const result = await mutator(state)
    await Promise.all(Object.entries(defaultFiles)
      .filter(([key]) => before[key] !== JSON.stringify(state[key]))
      .map(([key, file]) => writeJson(file, state[key])))
    return result
  })
  fileWriteLock = operation.catch(() => {})
  return operation
}

function cents(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return 0
  return Math.round(amount * 100)
}

function moneyDetails(details = {}) {
  const copy = structuredClone(details)
  if (copy.amount !== undefined) copy.amountCents = cents(copy.amount)
  if (copy.total !== undefined) copy.totalCents = cents(copy.total)
  if (copy.amount !== undefined) delete copy.amount
  if (copy.total !== undefined) delete copy.total
  return copy
}

function restoreMoneyDetails(details = {}) {
  const copy = structuredClone(details)
  if (copy.amountCents !== undefined) copy.amount = (copy.amountCents / 100).toFixed(2)
  if (copy.totalCents !== undefined) copy.total = (copy.totalCents / 100).toFixed(2)
  delete copy.amountCents
  delete copy.totalCents
  return copy
}

function normalizeAction(action) {
  if (!action) return null
  return { ...action, details: restoreMoneyDetails(action.details) }
}

function firestoreTimestamp(value) {
  return value instanceof Date ? value : new Date(value)
}

function actionRef(id) {
  return firestore.collection('pendingActions').doc(id)
}

export async function ensureUser(userId) {
  if (!userId) throw new Error('A user ID is required.')
  if (isFirestore()) {
    assertFirestoreConfig()
    const ref = firestore.collection('users').doc(userId)
    await ref.set({ userId, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { userId }
  }
  await updateFileState((state) => {
    state.users[userId] = { ...(state.users[userId] || {}), userId, updatedAt: new Date().toISOString() }
  })
  return { userId }
}

export async function listContacts(userId = 'default') {
  if (isFirestore()) {
    assertFirestoreConfig()
    const snapshot = await firestore.collection('users').doc(userId).collection('contacts').limit(20).get()
    if (!snapshot.empty) return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    await Promise.all(defaultContacts.map((contact) =>
      firestore.collection('users').doc(userId).collection('contacts').doc(contact.nickname).set(contact),
    ))
    return defaultContacts
  }
  const state = await getFileState()
  const contacts = Array.isArray(state.contacts) ? state.contacts : state.contacts[userId]
  return contacts?.length ? contacts : defaultContacts
}

export async function addContact(userId, contact) {
  if (isFirestore()) {
    assertFirestoreConfig()
    const ref = firestore.collection('users').doc(userId).collection('contacts').doc(contact.nickname)
    await ref.create(contact)
    return { id: ref.id, ...contact }
  }
  return updateFileState((state) => {
    const contacts = Array.isArray(state.contacts) ? state.contacts : (state.contacts[userId] || [])
    contacts.push(contact)
    state.contacts = Array.isArray(state.contacts) ? contacts : { ...state.contacts, [userId]: contacts }
    return contact
  })
}

export async function getCredentials(userId) {
  if (isFirestore()) {
    assertFirestoreConfig()
    const snapshot = await firestore.collection('users').doc(userId).collection('credentials').limit(20).get()
    return snapshot.docs.map((doc) => ({ credentialID: doc.id, ...doc.data() }))
  }

  const state = await getFileState()
  const value = state.credentials[userId]
  return Array.isArray(value) ? value : []
}

export async function getPinRecord(userId) {
  if (isFirestore()) {
    assertFirestoreConfig()
    const snapshot = await firestore.collection('users').doc(userId).collection('security').doc('pin').get()
    return snapshot.exists ? snapshot.data() : null
  }
  const state = await getFileState()
  return state.pins[userId] || null
}

export async function savePinRecord(userId, record) {
  if (isFirestore()) {
    assertFirestoreConfig()
    await firestore.collection('users').doc(userId).collection('security').doc('pin').set(record)
    return record
  }
  return updateFileState((state) => {
    state.pins[userId] = record
    return record
  })
}

export async function saveCredential(userId, credential) {
  if (isFirestore()) {
    assertFirestoreConfig()
    await firestore.collection('users').doc(userId).collection('credentials').doc(credential.credentialID).set(credential)
    return credential
  }
  return updateFileState((state) => {
    const credentials = Array.isArray(state.credentials[userId]) ? state.credentials[userId] : []
    state.credentials[userId] = [...credentials.filter((item) => item.credentialID !== credential.credentialID), credential]
    return credential
  })
}

export async function removeCredentials(userId) {
  if (isFirestore()) {
    assertFirestoreConfig()
    const snapshot = await firestore.collection('users').doc(userId).collection('credentials').limit(20).get()
    const batch = firestore.batch()
    snapshot.docs.forEach((doc) => batch.delete(doc.ref))
    await batch.commit()
    return
  }
  await updateFileState((state) => { delete state.credentials[userId] })
}

export async function updateCredentialCounter(userId, credentialId, counter) {
  if (isFirestore()) {
    assertFirestoreConfig()
    const ref = firestore.collection('users').doc(userId).collection('credentials').doc(credentialId)
    await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref)
      const current = snapshot.data()?.counter ?? 0
      if (counter !== 0 && current !== 0 && counter <= current) {
        const error = new Error('This device response was already used. Please try again.')
        error.code = 'WEBAUTHN_COUNTER_ROLLBACK'
        throw error
      }
      transaction.update(ref, { counter })
    })
    return
  }
  await updateFileState((state) => {
    const credential = (state.credentials[userId] || []).find((item) => item.credentialID === credentialId)
    const current = credential?.counter ?? 0
    if (!credential) throw new Error('This device is not registered. Set it up again in Settings.')
    if (counter !== 0 && current !== 0 && counter <= current) {
      const error = new Error('This device response was already used. Please try again.')
      error.code = 'WEBAUTHN_COUNTER_ROLLBACK'
      throw error
    }
    credential.counter = counter
  })
}

export async function saveChallenge(id, challenge) {
  if (isFirestore()) {
    assertFirestoreConfig()
    await firestore.collection('webauthnChallenges').doc(id).set({
      ...challenge,
      expiresAt: firestoreTimestamp(challenge.expiresAt),
    })
    return
  }
  await updateFileState((state) => { state.challenges[id] = challenge })
}

export async function getAndConsumeChallenge(id) {
  if (isFirestore()) {
    assertFirestoreConfig()
    const ref = firestore.collection('webauthnChallenges').doc(id)
    return firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref)
      if (!snapshot.exists) return null
      const data = snapshot.data()
      transaction.delete(ref)
      return { id: snapshot.id, ...data, expiresAt: data.expiresAt.toDate().toISOString() }
    })
  }
  return updateFileState((state) => {
    const challenge = state.challenges[id]
    delete state.challenges[id]
    return challenge || null
  })
}

export async function createPendingAction(action) {
  if (isFirestore()) {
    assertFirestoreConfig()
    const ref = actionRef(action.id)
    await ref.create({ ...action, userId: action.userId, details: moneyDetails(action.details), expiresAt: firestoreTimestamp(action.expiresAt) })
    return action
  }
  await updateFileState((state) => {
    const stored = { ...action, details: moneyDetails(action.details) }
    if (Array.isArray(state.pendingActions)) state.pendingActions.push(stored)
    else state.pendingActions[action.id] = stored
  })
  return action
}

export async function getPendingAction(actionId, userId) {
  if (isFirestore()) {
    assertFirestoreConfig()
    const snapshot = await actionRef(actionId).get()
    if (!snapshot.exists || snapshot.data().userId !== userId) return null
    const action = snapshot.data()
    return normalizeAction({ id: snapshot.id, ...action, expiresAt: action.expiresAt.toDate?.().toISOString?.() || action.expiresAt })
  }
  const state = await getFileState()
  const action = Array.isArray(state.pendingActions)
    ? state.pendingActions.find((item) => item.id === actionId)
    : state.pendingActions[actionId]
  return action?.userId === userId ? normalizeAction({ ...action }) : null
}

export async function updatePendingAction(action) {
  if (isFirestore()) {
    assertFirestoreConfig()
    const copy = { ...action, details: moneyDetails(action.details) }
    delete copy.id
    await actionRef(action.id).set(copy, { merge: true })
    return action
  }
  await updateFileState((state) => {
    const stored = { ...action, details: moneyDetails(action.details) }
    if (Array.isArray(state.pendingActions)) {
      state.pendingActions = [...state.pendingActions.filter((item) => item.id !== action.id), stored]
    } else {
      state.pendingActions[action.id] = stored
    }
  })
  return action
}

export async function claimPendingAction(actionId, userId) {
  if (isFirestore()) {
    assertFirestoreConfig()
    return firestore.runTransaction(async (transaction) => {
      const ref = actionRef(actionId)
      const snapshot = await transaction.get(ref)
      if (!snapshot.exists || snapshot.data().userId !== userId) return null
      const data = snapshot.data()
      if (data.status !== 'pending') return null
      transaction.update(ref, { status: 'processing', executingAt: FieldValue.serverTimestamp() })
      return normalizeAction({ id: snapshot.id, ...data, status: 'processing', expiresAt: data.expiresAt.toDate().toISOString() })
    })
  }
  return updateFileState((state) => {
    const action = Array.isArray(state.pendingActions)
      ? state.pendingActions.find((item) => item.id === actionId)
      : state.pendingActions[actionId]
    if (!action || action.userId !== userId || action.status !== 'pending') return null
    action.status = 'processing'
    action.executingAt = new Date().toISOString()
    return normalizeAction({ ...action })
  })
}

export async function listTransactions(userId, limit = 20) {
  if (isFirestore()) {
    assertFirestoreConfig()
    const snapshot = await firestore.collection('users').doc(userId).collection('transactions')
      .orderBy('createdAt', 'desc').limit(Math.min(limit, 20)).get()
    return snapshot.docs.map((doc) => doc.data())
  }
  const state = await getFileState()
  const entries = Array.isArray(state.transactions)
    ? state.transactions
    : state.transactions[userId] || []
  return entries.slice(-limit).reverse().map((entry) => ({
    ...entry,
    details: restoreMoneyDetails(entry.details),
  }))
}

export async function addTransaction(userId, entry) {
  const id = entry.actionId || randomUUID()
  const stored = { ...entry, id, details: moneyDetails(entry.details), expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString() }
  if (isFirestore()) {
    assertFirestoreConfig()
    await firestore.collection('users').doc(userId).collection('transactions').doc(id).set(stored)
    return entry
  }
  await updateFileState((state) => {
    if (Array.isArray(state.transactions)) {
      state.transactions.push(stored)
    } else {
      if (!Array.isArray(state.transactions[userId])) state.transactions[userId] = []
      state.transactions[userId].push(stored)
    }
  })
  return entry
}

export async function updateTransactions(userId, entries) {
  if (isFirestore()) {
    assertFirestoreConfig()
    const batch = firestore.batch()
    entries.slice(0, 20).forEach((entry) => batch.set(firestore.collection('users').doc(userId).collection('transactions').doc(entry.id || entry.actionId || randomUUID()), entry))
    await batch.commit()
    return
  }
  await updateFileState((state) => { state.transactions = entries })
}

export async function updateSession(sessionId, updates = {}) {
  if (isFirestore()) {
    assertFirestoreConfig()
    await firestore.collection('users').doc(sessionId).set({ sessionId, ...updates, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return
  }
  await updateFileState((state) => { state.sessions[sessionId] = { ...(state.sessions[sessionId] || {}), ...updates } })
}

export async function getSession(sessionId) {
  if (isFirestore()) {
    assertFirestoreConfig()
    const snapshot = await firestore.collection('users').doc(sessionId).get()
    return snapshot.data() || {}
  }
  const state = await getFileState()
  return state.sessions[sessionId] || {}
}

export async function checkConnection() {
  const id = `check-${randomUUID()}`
  if (isFirestore()) {
    assertFirestoreConfig()
    const ref = firestore.collection('_voicepay_checks').doc(id)
    await ref.set({ id, createdAt: FieldValue.serverTimestamp() })
    const snapshot = await ref.get()
    await ref.delete()
    return snapshot.exists && snapshot.data().id === id
  }
  await updateFileState((state) => { state.users[id] = { id } })
  const state = await getFileState()
  const ok = state.users[id]?.id === id
  await updateFileState((current) => { delete current.users[id] })
  return ok
}

export function getStorageDriver() {
  return isFirestore() ? 'firestore' : 'file'
}

export { cents, restoreMoneyDetails }

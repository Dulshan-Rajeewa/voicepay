import { GoogleGenAI } from '@google/genai'
import { config } from '../config.js'
import { getSession, updateSession } from '../db/index.js'
import { getProduct, searchProducts } from './catalog.js'
import { findContact, listContacts } from './contacts.js'
import {
  cancelPendingAction,
  createPendingAction,
  getTransactionLog,
  logCancelledAction,
  toPublicPendingAction,
} from './pending.js'
import { getBalances, getRecentTransactions, syncPendingPayouts } from './paypal.js'

const sessionHistories = new Map()
const sessionPendingActions = new Map()
const ai = config.geminiApiKey ? new GoogleGenAI({ apiKey: config.geminiApiKey }) : null

const systemInstruction = `You are VoicePay, an accessible payment assistant for blind and deafblind users.
Speak in short, clear, screen-reader-friendly sentences. Do not use markdown, emoji, or tables.
Always read every amount using both words and digits, such as twenty dollars ($20.00).
Never claim money has moved until the server reports a completed payment.
Ask a clear clarification question when a contact or amount is ambiguous.
Never read out full card numbers, bank account numbers, or other sensitive account numbers.
When describing products, turn only the returned catalog fields into a natural audio description. Explain what an image would show using the size, color, materials, box contents, care, tactile, and sound or voice fields. Never invent product facts.
When a user asks for a comparison, compare no more than three returned products and name the differences using only catalog fields.
Use propose_payment and propose_purchase only to prepare a pending action. The user must explicitly confirm it later.
Do not treat a proposal as a completed payment.`

const functionDeclarations = [
  {
    name: 'get_balance',
    description: 'Get the current PayPal balances.',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_recent_payments',
    description: 'Get recent PayPal payments.',
    parametersJsonSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
    },
  },
  {
    name: 'list_contacts',
    description: 'List saved payment contacts.',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_payment',
    description: 'Prepare a payment pending explicit user confirmation. Never sends money.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        contactName: { type: 'string' },
        amount: { type: 'number', minimum: 0.01 },
        note: { type: 'string' },
      },
      required: ['contactName', 'amount'],
    },
  },
  {
    name: 'search_products',
    description: 'Search the accessible demo product catalog.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxPrice: { type: 'number', minimum: 0.01 },
      },
      required: ['query'],
    },
  },
  {
    name: 'describe_product',
    description: 'Describe one catalog product by its ID.',
    parametersJsonSchema: {
      type: 'object',
      properties: { productId: { type: 'string' } },
      required: ['productId'],
    },
  },
  {
    name: 'propose_purchase',
    description: 'Prepare a product purchase pending explicit user confirmation. Never charges money.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        quantity: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['productId', 'quantity'],
    },
  },
  {
    name: 'cancel_pending',
    description: 'Cancel the current session pending action.',
    parametersJsonSchema: { type: 'object', properties: {} },
  },
]

function amountWords(value) {
  const amount = Number(value)
  const whole = Math.floor(amount)
  const cents = Math.round((amount - whole) * 100)
  const smallNumbers = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
    'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
    'sixteen', 'seventeen', 'eighteen', 'nineteen',
  ]
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
  const words =
    whole < 20
      ? smallNumbers[whole]
      : whole < 100
        ? `${tens[Math.floor(whole / 10)]}${whole % 10 ? `-${smallNumbers[whole % 10]}` : ''}`
        : `${smallNumbers[Math.floor(whole / 100)]} hundred${whole % 100 ? ` ${amountWords(whole % 100).split(' dollars')[0]}` : ''}`

  return `${words} dollars and ${String(cents).padStart(2, '0')} cents ($${amount.toFixed(2)})`
}

function spokenPaymentSummary(contact, amount, note) {
  const noteText = note ? ` Note: ${note}.` : ''
  return `Send ${amountWords(amount)} to ${contact.name} at ${contact.email}.${noteText} Say confirm to send, or cancel.`
}

function spokenPurchaseSummary(product, quantity, total) {
  return `Buy ${quantity} of ${product.name} for ${amountWords(total)}. Say confirm to purchase, or cancel.`
}

async function proposePayment(args, sessionId) {
  const lookup = await findContact(args.contactName, sessionId)
  if (!lookup.contact) {
    return lookup.ambiguous
      ? { clarification: `I found multiple contacts: ${lookup.matches.map((contact) => contact.name).join(', ')}. Which one do you mean?` }
      : { clarification: `I could not find ${args.contactName}. Please say the contact name again.` }
  }

  const amount = Number(args.amount)
  if (!Number.isFinite(amount) || amount <= 0 || amount > config.maxPaymentUsd) {
    return { clarification: `Please provide an amount from one cent to ${config.maxPaymentUsd.toFixed(2)} dollars.` }
  }

  const action = await createPendingAction({
    type: 'send_money',
    details: {
      email: lookup.contact.email,
      amount: amount.toFixed(2),
      currency: 'USD',
      note: args.note,
    },
    humanSummary: spokenPaymentSummary(lookup.contact, amount, args.note),
    sessionId,
  })
  sessionPendingActions.set(sessionId, action.id)
  await updateSession(sessionId, { pendingActionId: action.id })
  return { pendingAction: toPublicPendingAction(action) }
}

async function proposePurchase(args, sessionId) {
  const product = await getProduct(args.productId)
  const quantity = Number(args.quantity)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
    return { clarification: 'Please choose a quantity from one to twenty.' }
  }

  const total = product.price * quantity
  if (total > config.maxPaymentUsd) {
    return { clarification: `That purchase is over the ${config.maxPaymentUsd.toFixed(2)} dollar payment limit.` }
  }

  const action = await createPendingAction({
    type: 'purchase',
    details: {
      items: [{
        name: product.name,
        quantity,
        unitAmount: product.price.toFixed(2),
        description: product.description,
        size: product.size,
        color: product.color,
        materials: product.materials,
        box: product.box,
        care: product.care,
        tactile: product.tactile,
        soundVoice: product.soundVoice,
      }],
      total: total.toFixed(2),
      currency: 'USD',
    },
    humanSummary: spokenPurchaseSummary(product, quantity, total),
    sessionId,
  })
  sessionPendingActions.set(sessionId, action.id)
  await updateSession(sessionId, { pendingActionId: action.id })
  return { pendingAction: toPublicPendingAction(action) }
}

async function getRecentPayments(limit, userId) {
  await syncPendingPayouts(userId)
  const paypalPayments = await getRecentTransactions(limit)
  if (config.useMockPaypal) return paypalPayments

  const contacts = await listContacts(userId)
  const contactByEmail = new Map(
    contacts.map((contact) => [contact.email.trim().toLowerCase(), contact]),
  )
  const localPayments = (await getTransactionLog(userId))
    .filter(
      (entry) =>
        entry.type === 'send_money' &&
        Boolean(entry.payoutBatchId || entry.result?.batchId) &&
        ['confirmed', 'COMPLETED', 'PENDING'].includes(entry.status) &&
        !['DENIED', 'FAILED', 'CANCELLED'].includes(entry.status) &&
        !String(entry.payoutBatchId || entry.result?.batchId).startsWith('MOCK-'),
    )
    .map((entry) => ({
      transaction_info: {
        transaction_id: entry.result.batchId,
        transaction_initiation_date: entry.confirmedAt,
        transaction_status: entry.status === 'confirmed'
          ? (entry.result.status === 'PENDING' ? 'PENDING' : 'COMPLETED')
          : entry.status,
        transaction_amount: {
          value: entry.details.amount,
          currency_code: entry.details.currency,
        },
        transaction_subject: `Payment to ${
          contactByEmail.get(entry.details.email.toLowerCase())?.name ||
          entry.details.email
        }`,
        recipientEmail: entry.details.email,
      },
    }))

  const nameTransactions = (transactions) => transactions.map((transaction) => {
    const info = transaction.transaction_info || {}
    const email = info.receiver_email ||
      info.receiver_info?.email_address ||
      info.payee_info?.email_address ||
      transaction.recipientEmail
    const contact = email && contactByEmail.get(email.toLowerCase())
    if (!contact) return transaction
    return {
      ...transaction,
      transaction_info: {
        ...info,
        recipientName: contact.name,
        transaction_subject: `Payment to ${contact.name}`,
      },
    }
  })

  const seen = new Set()
  const localKeys = localPayments.map((transaction) => transaction.transaction_info)
  const transactions = nameTransactions([...localPayments, ...paypalPayments.transactions])
    .filter((transaction) => {
      const info = transaction.transaction_info || {}
      const idKey = info.transaction_id ? `id:${info.transaction_id}` : null
      const amount = Number(info.transaction_amount?.value)
      const timestamp = new Date(info.transaction_initiation_date || 0).getTime()
      const subject = String(info.transaction_subject || '').toLowerCase()
      const duplicateLocal = !localKeys.includes(info) && localKeys.some((localInfo) => {
        const localAmount = Number(localInfo.transaction_amount?.value)
        const localTimestamp = new Date(localInfo.transaction_initiation_date || 0).getTime()
        const localSubject = String(localInfo.transaction_subject || '').toLowerCase()
        return (
          Number.isFinite(amount) &&
          amount === localAmount &&
          Math.abs(timestamp - localTimestamp) <= 10 * 60 * 1000 &&
          subject === localSubject
        )
      })
      if (idKey && seen.has(idKey) || duplicateLocal) return false
      if (idKey) seen.add(idKey)
      return true
    })
    .sort((left, right) => {
      const leftDate = left.transaction_info?.transaction_initiation_date ?? ''
      const rightDate = right.transaction_info?.transaction_initiation_date ?? ''
      return rightDate.localeCompare(leftDate)
    })
    .slice(0, limit)

  return {
    transactions,
    totalItems: transactions.length,
  }
}

async function executeTool(name, args, sessionId) {
  switch (name) {
    case 'get_balance':
      return getBalances(sessionId)
    case 'get_recent_payments':
      return getRecentPayments(args.limit ?? 20, sessionId)
    case 'list_contacts':
      return listContacts(sessionId)
    case 'propose_payment':
      return proposePayment(args, sessionId)
    case 'search_products':
      return searchProducts(args.query, args.maxPrice)
    case 'describe_product':
      return getProduct(args.productId)
    case 'propose_purchase':
      return proposePurchase(args, sessionId)
    case 'cancel_pending': {
      const actionId = sessionPendingActions.get(sessionId) || (await getSession(sessionId)).pendingActionId
      if (!actionId) {
        return { clarification: 'There is no pending action to cancel.' }
      }
      const action = await cancelPendingAction(actionId, sessionId)
      await logCancelledAction(action)
      sessionPendingActions.delete(sessionId)
      await updateSession(sessionId, { pendingActionId: null })
      return { cancelled: true, action }
    }
    default:
      throw new Error('The requested assistant tool is unavailable.')
  }
}

async function getHistory(sessionId) {
  if (!sessionHistories.has(sessionId)) {
    const stored = await getSession(sessionId)
    sessionHistories.set(sessionId, Array.isArray(stored.history) ? stored.history : [])
  }
  return sessionHistories.get(sessionId)
}

function getLocalGreeting(message) {
  if (/^(hi|hello|hey|good morning|good afternoon|good evening)[!.? ]*$/i.test(message.trim())) {
    return {
      reply: 'Hello. I am VoicePay, your accessible payment assistant. How can I help you today?',
      pendingAction: null,
    }
  }
  return null
}

const spokenAmounts = new Map([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['ten', 10],
  ['twenty', 20],
  ['thirty', 30],
  ['forty', 40],
  ['fifty', 50],
  ['one hundred', 100],
])

function getLocalPaymentRequest(message) {
  const match = message.trim().match(
    /^(?:send|pay|give|transfer)\s+(.+?)(?:\s+(?:dollars?|usd))?\s+to\s+(.+)$/i,
  )
  if (!match) return null

  const amountText = match[1].trim().toLowerCase()
  const amount = Number(amountText) || spokenAmounts.get(amountText)
  if (!amount) return null
  return { amount, contactName: match[2].trim() }
}

function getErrorStatus(error) {
  return Number(error?.status ?? error?.statusCode ?? error?.error?.code)
}

function isTemporaryGeminiError(error) {
  return [429, 500, 502, 503, 504].includes(getErrorStatus(error))
}

function isQuotaExceeded(error) {
  return getErrorStatus(error) === 429 && /quota|rate limit/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

async function generateResponse(contents) {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await ai.models.generateContent({
        model: config.geminiModel,
        contents,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations }],
        },
      })
    } catch (error) {
      const status = getErrorStatus(error)
      const details = error instanceof Error ? error.message : String(error)
      console.error(`Gemini request failed (attempt ${attempt}/${maxAttempts}):`, details)

      if (attempt < maxAttempts && isTemporaryGeminiError(error) && !isQuotaExceeded(error)) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)))
        continue
      }

      const message =
        status === 401 || status === 403
          ? 'The assistant could not authenticate with Gemini. Please check GEMINI_API_KEY.'
          : status === 404
            ? 'The configured Gemini model is unavailable. Please check GEMINI_MODEL.'
            : isQuotaExceeded(error)
              ? 'The assistant has reached its Gemini usage limit. Payment proposals can still be prepared, but general questions require a new quota window or billing plan.'
            : 'The assistant service is temporarily unavailable. Please try again in a moment.'
      const serviceError = new Error(message)
      serviceError.statusCode = 502
      throw serviceError
    }
  }
}

export async function chat({ sessionId, message }) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('Please provide a message.')
  }

  const localGreeting = getLocalGreeting(message)
  if (localGreeting) {
    return localGreeting
  }

  const localPaymentRequest = getLocalPaymentRequest(message)
  if (localPaymentRequest) {
    const result = await proposePayment(localPaymentRequest, sessionId)
    return {
      reply:
        result.pendingAction?.humanSummary ||
        result.clarification ||
        'I could not prepare that payment.',
      pendingAction: result.pendingAction || null,
    }
  }

  if (!ai) {
    return {
      reply: 'Gemini is not configured. Add GEMINI_API_KEY to server/.env to start the assistant.',
      pendingAction: null,
    }
  }

  const history = await getHistory(sessionId)
  history.push({ role: 'user', parts: [{ text: message.trim() }] })
  let response = await generateResponse(history)

  let pendingAction = null
  for (let toolRound = 0; response.functionCalls?.length && toolRound < 3; toolRound += 1) {
    const modelContent = response.candidates?.[0]?.content ?? {
      role: 'model',
      parts: response.functionCalls.map((functionCall) => ({ functionCall })),
    }
    history.push(modelContent)
    const functionResponses = []

    for (const functionCall of response.functionCalls) {
      try {
        const result = await executeTool(
          functionCall.name,
          functionCall.args ?? {},
          sessionId,
        )
        if (result.pendingAction) {
          pendingAction = result.pendingAction
        }
        functionResponses.push({
          functionResponse: {
            name: functionCall.name,
            response: { result },
          },
        })
      } catch (error) {
        functionResponses.push({
          functionResponse: {
            name: functionCall.name,
            response: { error: error.message },
          },
        })
      }
    }

    history.push({ role: 'user', parts: functionResponses })
    response = await generateResponse(history)
  }

  const reply = response.text?.trim() || 'I could not prepare a response. Please try again.'
  const finalContent = response.candidates?.[0]?.content
  if (finalContent) {
    history.push(finalContent)
  } else {
    history.push({ role: 'model', parts: [{ text: reply }] })
  }

  await updateSession(sessionId, {
    history: history.slice(-20),
    pendingActionId: sessionPendingActions.get(sessionId) || null,
  })
  return { reply, pendingAction }
}

export function clearAgentSessions() {
  sessionHistories.clear()
  sessionPendingActions.clear()
}

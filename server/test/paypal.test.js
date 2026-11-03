import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

process.env.USE_MOCK_PAYPAL = 'false'
process.env.PAYPAL_CLIENT_ID = 'sandbox-client'
process.env.PAYPAL_CLIENT_SECRET = 'sandbox-secret'
process.env.TRANSACTION_LOG_PATH = path.join(
  os.tmpdir(),
  `voicepay-paypal-transactions-${process.pid}.json`,
)

const { getBalances, getRecentTransactions, syncPendingPayouts } =
  await import('../src/services/paypal.js')

const transactionPath = process.env.TRANSACTION_LOG_PATH
const originalFetch = globalThis.fetch

function mockFetch(responses) {
  let index = 0
  globalThis.fetch = async (url) => {
    const response = responses[index++]
    if (!response) throw new Error(`Unexpected PayPal request: ${url}`)
    return {
      ok: true,
      status: 200,
      json: async () => response,
    }
  }
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  await unlink(transactionPath).catch(() => {})
})

test('syncs pending payout status to completed', async () => {
  await writeFile(transactionPath, JSON.stringify([{
    actionId: 'action-1',
    type: 'send_money',
    status: 'PENDING',
    payoutBatchId: 'PAYOUT-1',
    details: { email: 'nimal@example.com', amount: '1.00', currency: 'USD' },
    result: { batchId: 'PAYOUT-1', status: 'PENDING' },
  }]))
  mockFetch([
    { access_token: 'token', expires_in: 0 },
    { batch_header: { payout_batch_id: 'PAYOUT-1', batch_status: 'SUCCESS' } },
  ])

  const entries = await syncPendingPayouts()

  assert.equal(entries[0].status, 'COMPLETED')
  assert.equal(entries[0].result.status, 'COMPLETED')
  const saved = JSON.parse(await readFile(transactionPath, 'utf8'))
  assert.equal(saved[0].status, 'COMPLETED')
})

test('filters sandbox funding and denied reporting transactions', async () => {
  mockFetch([
    { access_token: 'token', expires_in: 0 },
    {
      transaction_details: [
        {
          transaction_info: {
            transaction_id: 'FUNDING',
            transaction_status: 'S',
            transaction_amount: { value: '5000.00', currency_code: 'USD' },
            transaction_subject: 'Initial balance deposit',
          },
          payer_info: { email_address: 'PayPal' },
        },
        {
          transaction_info: {
            transaction_id: 'DENIED',
            transaction_status: 'D',
            transaction_amount: { value: '1.00', currency_code: 'USD' },
          },
        },
        {
          transaction_info: {
            transaction_id: 'PAYMENT',
            transaction_status: 'S',
            transaction_amount: { value: '1.00', currency_code: 'USD' },
            transaction_initiation_date: '2026-11-03T10:00:00Z',
            transaction_subject: 'Payment to nimal@example.com',
          },
        },
      ],
    },
  ])

  const result = await getRecentTransactions()

  assert.deepEqual(result.transactions.map(({ transaction_info: info }) => ({
    id: info.transaction_id,
    status: info.transaction_status,
  })), [{ id: 'PAYMENT', status: 'COMPLETED' }])
})

test('deducts recent local outflows from the live balance', async () => {
  await writeFile(transactionPath, JSON.stringify([{
    actionId: 'action-2',
    type: 'send_money',
    status: 'COMPLETED',
    details: { email: 'nimal@example.com', amount: '1.00', currency: 'USD' },
    confirmedAt: '2026-11-03T10:05:00Z',
    result: { batchId: 'PAYOUT-2', status: 'SUCCESS' },
  }]))
  mockFetch([
    { access_token: 'token', expires_in: 0 },
    {
      as_of_time: '2026-11-03T10:00:00Z',
      balances: [{ currency: 'USD', available: '5000.00', withheld: '0.00' }],
    },
  ])

  const result = await getBalances()

  assert.equal(result.balances[0].available, '4999.00')
})

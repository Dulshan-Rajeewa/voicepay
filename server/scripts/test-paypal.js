process.env.USE_MOCK_PAYPAL ??= 'true'

const {
  captureOrder,
  createOrder,
  getAccessToken,
  getBalances,
  getRecentTransactions,
  sendPayout,
} = await import('../src/services/paypal.js')

const token = await getAccessToken()
console.log(`Access token acquired: ${token ? 'yes' : 'no'}`)

console.log('Payout:', await sendPayout({
  email: 'demo@example.com',
  amount: '12.50',
  currency: 'USD',
  note: 'VoicePay demo payout',
}))

console.log('Transactions:', await getRecentTransactions(5))
console.log('Balances:', await getBalances())

const order = await createOrder({
  items: [{ name: 'Demo accessibility product', quantity: 1, unitAmount: '19.99' }],
  total: '19.99',
  currency: 'USD',
})
console.log('Order:', order)
console.log('Capture:', await captureOrder(order.orderId))

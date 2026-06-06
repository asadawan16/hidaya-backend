function authHeader() {
  return 'Basic ' + Buffer.from(`${process.env.MC_API_USERNAME}:${process.env.MC_API_PASSWORD}`).toString('base64')
}

function apiUrl(path) {
  return `${process.env.MC_GATEWAY_URL}/api/rest/version/100/merchant/${process.env.MC_MERCHANT_ID}${path}`
}

export async function createCheckoutSession({ orderId, amount, currency, plan, returnUrl, cancelUrl, customerName, customerEmail }) {
  const customer = {}
  if (customerName) customer.firstName = customerName
  if (customerEmail) customer.email = customerEmail

  const res = await fetch(apiUrl('/session'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader(),
    },
    body: JSON.stringify({
      apiOperation: 'INITIATE_CHECKOUT',
      interaction: {
        operation: 'PURCHASE',
        returnUrl,
        cancelUrl,
        merchant: { name: 'Hidaya Online' },
        displayControl: {
          billingAddress: 'MANDATORY',
        },
      },
      order: {
        id: orderId,
        amount: String(amount),
        currency: currency || 'PKR',
        description: `Hidaya Online - ${plan}`,
      },
      ...(Object.keys(customer).length > 0 && { customer }),
    }),
  })

  return res.json()
}

export async function initiateBrowserPayment({ orderId, transactionId, amount, currency, plan, returnUrl }) {
  const res = await fetch(apiUrl(`/order/${orderId}/transaction/${transactionId}`), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader(),
    },
    body: JSON.stringify({
      apiOperation: 'INITIATE_BROWSER_PAYMENT',
      sourceOfFunds: { type: 'PAYPAL' },
      browserPayment: {
        operation: 'PAY',
        paypal: { paymentConfirmation: 'CONFIRM_AT_PROVIDER' },
        returnUrl,
      },
      order: {
        amount: String(amount),
        currency,
        description: `Hidaya Online - ${plan}`,
      },
    }),
  })

  return res.json()
}

export async function retrieveOrder(orderId) {
  const res = await fetch(apiUrl(`/order/${orderId}`), {
    method: 'GET',
    headers: { 'Authorization': authHeader() },
  })

  return res.json()
}

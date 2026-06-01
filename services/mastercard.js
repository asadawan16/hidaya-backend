function authHeader() {
  return 'Basic ' + Buffer.from(`${process.env.MC_API_USERNAME}:${process.env.MC_API_PASSWORD}`).toString('base64')
}

function apiUrl(path) {
  return `${process.env.MC_GATEWAY_URL}/api/rest/version/73/merchant/${process.env.MC_MERCHANT_ID}${path}`
}

export async function createCheckoutSession({ orderId, amount, plan, returnUrl, cancelUrl }) {
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
        merchant: { name: 'Hidaya Online Education' },
      },
      order: {
        id: orderId,
        amount: String(amount),
        currency: 'PKR',
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

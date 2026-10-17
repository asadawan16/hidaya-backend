/*
 * Meta Graph API calls for WhatsApp onboarding (Embedded Signup).
 *
 * The app id and the Embedded Signup configuration id are PUBLIC values — the
 * browser needs both to launch FB.login — so they default to HidayaOnlineApp's
 * and can be overridden per host. The app secret is the same
 * WHATSAPP_APP_SECRET that signs webhooks (one Meta app does both).
 */
export const META_APP_ID = process.env.META_APP_ID || '1132996029231135'
export const WHATSAPP_ES_CONFIG_ID = process.env.WHATSAPP_ES_CONFIG_ID || '1761286151831686'
export const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0'

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`

export class GraphError extends Error {
  constructor(message, { status, code, subcode } = {}) {
    super(message)
    this.name = 'GraphError'
    this.status = status
    this.code = code
    this.subcode = subcode
  }
}

async function graph(path, { method = 'GET', token, query, body } = {}) {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, '')}`)
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v)

  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body) headers['Content-Type'] = 'application/json'

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  if (!res.ok || data?.error) {
    const e = data?.error || {}
    throw new GraphError(e.error_user_msg || e.message || `Graph API ${res.status}`, {
      status: res.status, code: e.code, subcode: e.error_subcode,
    })
  }
  return data
}

/*
 * The `code` from FB.login is single-use and short-lived (~30s), so the
 * browser posts it straight here. The JS SDK flow has no redirect_uri.
 */
export async function exchangeCodeForToken(code) {
  const secret = process.env.WHATSAPP_APP_SECRET
  if (!secret) throw new GraphError('WHATSAPP_APP_SECRET is not set on the server')
  const data = await graph('oauth/access_token', {
    query: { client_id: META_APP_ID, client_secret: secret, code },
  })
  if (!data?.access_token) throw new GraphError('Meta returned no access token')
  return data.access_token
}

export async function listPhoneNumbers(wabaId, token) {
  const data = await graph(`${wabaId}/phone_numbers`, {
    token, query: { fields: 'id,display_phone_number,verified_name,quality_rating' },
  })
  return data?.data || []
}

// Points this WABA's webhooks at our app (and so at /api/whatsapp/webhook)
export function subscribeApp(wabaId, token) {
  return graph(`${wabaId}/subscribed_apps`, { method: 'POST', token })
}

export function unsubscribeApp(wabaId, token) {
  return graph(`${wabaId}/subscribed_apps`, { method: 'DELETE', token })
}

/*
 * Coexistence only: ask Meta to replay the WhatsApp Business app's contacts
 * (`smb_app_state_sync`) or chat history (`history`) as webhooks. Meta accepts
 * this only within 24 hours of onboarding.
 */
export function requestAppSync(phoneNumberId, token, syncType) {
  return graph(`${phoneNumberId}/smb_app_data`, {
    method: 'POST', token, body: { messaging_product: 'whatsapp', sync_type: syncType },
  })
}

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
const GRAPH_TIMEOUT_MS = 30_000

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

  // Without a timeout a hung Graph call would hold the request (and a class
  // reminder's claim) open indefinitely; an abort surfaces as a TimeoutError.
  const res = await fetch(url, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  })
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

/*
 * What a pasted access token is: which app it belongs to, whether it still
 * works, when it expires (0 = never) and its permissions. Asked with the app's
 * own token (app id|secret), which can inspect any token issued for this app.
 */
export async function inspectToken(token) {
  const secret = process.env.WHATSAPP_APP_SECRET
  if (!secret) throw new GraphError('WHATSAPP_APP_SECRET is not set on the server')
  const data = await graph('debug_token', {
    query: { input_token: token, access_token: `${META_APP_ID}|${secret}` },
  })
  const d = data?.data || {}
  return {
    appId: d.app_id ? String(d.app_id) : '',
    isValid: d.is_valid === true,
    expiresAt: Number(d.expires_at) || 0,
    scopes: Array.isArray(d.scopes) ? d.scopes : [],
  }
}

// One number's details, including whether it is still on the WhatsApp Business app
export function getPhoneNumber(phoneNumberId, token) {
  return graph(phoneNumberId, {
    token, query: { fields: 'id,display_phone_number,verified_name,quality_rating,platform_type,is_on_biz_app' },
  })
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

/*
 * The Meta app's own webhook subscription — which fields Meta sends to our
 * callback URL. Asked with the app's token (app id|secret). Setting it makes
 * Meta call the callback's GET handshake with `verifyToken` straight away.
 */
const appToken = () => {
  const secret = process.env.WHATSAPP_APP_SECRET
  if (!secret) throw new GraphError('WHATSAPP_APP_SECRET is not set on the server')
  return `${META_APP_ID}|${secret}`
}

export async function getAppSubscription(object = 'whatsapp_business_account') {
  const data = await graph(`${META_APP_ID}/subscriptions`, { token: appToken() })
  const sub = (data?.data || []).find(s => s.object === object)
  if (!sub) return null
  return { callbackUrl: sub.callback_url || '', active: sub.active !== false, fields: (sub.fields || []).map(f => f.name) }
}

export function setAppSubscription({ callbackUrl, verifyToken, fields, object = 'whatsapp_business_account' }) {
  return graph(`${META_APP_ID}/subscriptions`, {
    method: 'POST', token: appToken(),
    query: { object, callback_url: callbackUrl, verify_token: verifyToken, fields: fields.join(','), include_values: 'true' },
  })
}

// ── Messaging + templates ───────────────────────────────────────────────────
// Returns Meta's wamid; statuses for it arrive later on the webhook.
export async function sendMessage(phoneNumberId, token, payload) {
  const data = await graph(`${phoneNumberId}/messages`, {
    method: 'POST', token, body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload },
  })
  const wamid = data?.messages?.[0]?.id
  if (!wamid) throw new GraphError('Meta accepted the request but returned no message id')
  return wamid
}

export async function listTemplates(wabaId, token) {
  const data = await graph(`${wabaId}/message_templates`, {
    token, query: { fields: 'id,name,status,category,language,components,rejected_reason', limit: '100' },
  })
  return data?.data || []
}

export function createTemplate(wabaId, token, template) {
  return graph(`${wabaId}/message_templates`, { method: 'POST', token, body: template })
}

// Blue ticks on the contact's side for an inbound message (and everything before it)
export function markMessageRead(phoneNumberId, token, wamid) {
  return graph(`${phoneNumberId}/messages`, {
    method: 'POST', token, body: { messaging_product: 'whatsapp', status: 'read', message_id: wamid },
  })
}

// ── Media ───────────────────────────────────────────────────────────────────
// Upload a file to Meta (multipart) and get back the media id to send it with
export async function uploadMedia(phoneNumberId, token, { buffer, mimeType, filename }) {
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', mimeType)
  form.append('file', new Blob([buffer], { type: mimeType }), filename || 'file')

  const res = await fetch(`${GRAPH}/${phoneNumberId}/media`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  })
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  if (!res.ok || data?.error || !data?.id) {
    const e = data?.error || {}
    throw new GraphError(e.error_user_msg || e.message || `Media upload failed (${res.status})`, { status: res.status, code: e.code })
  }
  return data.id
}

/*
 * A media id from a message → the file. Meta hands out a short-lived URL
 * (~5 min) that itself needs the token; ids for received media expire after
 * about 30 days, after which this throws a GraphError.
 */
export async function downloadMedia(mediaId, token) {
  const info = await graph(mediaId, { token })
  if (!info?.url) throw new GraphError('Meta returned no download URL for this file')
  const res = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) })
  if (!res.ok) throw new GraphError(`Could not download the file from WhatsApp (${res.status})`, { status: res.status })
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mimeType: info.mime_type || res.headers.get('content-type') || 'application/octet-stream',
  }
}

// Smoke test for connecting the WhatsApp number via Embedded Signup
// (controllers/portalWhatsappController.js → services/whatsappGraph.js).
//
// Covers:
//   - the signup code is exchanged with our app id + secret
//   - the number must belong to the WABA Meta reported
//   - our app is subscribed to the WABA's webhooks
//   - coexistence: contacts sync is requested, then history, and a failed
//     request is stored on the connection instead of failing the connect
//   - the token is stored encrypted and never returned by GET /connection
//   - a Meta error on the code exchange surfaces Meta's message
//   - sending: falls back to the API Setup test number when nothing is
//     connected, stores the outbound row under Meta's wamid, sends template
//     parameters, refuses local-format numbers
//   - templates: created on the sender's WABA with example values for {{n}}
//
// Meta is replaced by a stubbed global fetch — no Meta account, token or
// running server needed. Runs against a THROWAWAY database
// (hidaya_whatsapp_connect_smoke) and drops it afterwards.
// Run: node scripts/smoke-whatsapp-connect.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import '../models/User.js' // registers the model behind connectedBy's populate
import WhatsappConnection from '../models/WhatsappConnection.js'
import WhatsappMessage from '../models/WhatsappMessage.js'
import '../models/Student.js'
import {
  connectWhatsappNumber, getConnection, send, addTemplate, resolveSender,
} from '../controllers/portalWhatsappController.js'
import { decryptSecret } from '../utils/totp.js'
import { META_APP_ID } from '../services/whatsappGraph.js'

process.env.WHATSAPP_APP_SECRET = 'smoke-app-secret'
if (!process.env.MFA_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY.length !== 64) {
  process.env.MFA_ENCRYPTION_KEY = 'a'.repeat(64)
}

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }

// ── Fake Graph API ──────────────────────────────────────────────────────────
const calls = []
let sentSeq = 0
let failHistorySync = false
let failExchange = false
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  calls.push({ method, path: url.pathname.replace(/^\/v[\d.]+\//, ''), query: Object.fromEntries(url.searchParams), auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : null })
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  const path = calls.at(-1).path

  if (path === 'oauth/access_token') {
    if (failExchange) return json(400, { error: { message: 'This authorization code has expired.', code: 100 } })
    return json(200, { access_token: 'BUSINESS_TOKEN', token_type: 'bearer' })
  }
  if (path === 'WABA_1/phone_numbers') {
    return json(200, { data: [{ id: 'PN_1', display_phone_number: '+92 300 0000000', verified_name: 'Hidaya Online', quality_rating: 'GREEN' }] })
  }
  if (path === 'WABA_1/subscribed_apps') return json(200, { success: true })
  if (path === 'PN_1/messages' || path === 'PN_TEST/messages') {
    return json(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.SENT_${++sentSeq}`, message_status: 'accepted' }] })
  }
  if (path === 'WABA_TEST/message_templates' && method === 'POST') {
    return json(200, { id: 'TPL_1', status: 'PENDING', category: 'UTILITY' })
  }
  if (path === 'PN_1/smb_app_data') {
    if (calls.at(-1).body?.sync_type === 'history' && failHistorySync) {
      return json(400, { error: { message: 'Sync window has expired', code: 131000 } })
    }
    return json(200, { success: true })
  }
  return json(404, { error: { message: `unstubbed ${method} ${path}` } })
}

const SMOKE_DB = 'hidaya_whatsapp_connect_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}

const base = { code: 'CODE_1', wabaId: 'WABA_1', businessId: 'BIZ_1', coexistence: true }

try {
  console.log('\nConnect (coexistence)')
  let conn = await connectWhatsappNumber({ ...base, phoneNumberId: 'PN_1' })
  const exchange = calls.find(c => c.path === 'oauth/access_token')
  ok(exchange?.query.client_id === META_APP_ID && exchange?.query.client_secret === 'smoke-app-secret' && exchange?.query.code === 'CODE_1', 'code exchanged with our app id + secret')
  ok(calls.some(c => c.method === 'POST' && c.path === 'WABA_1/subscribed_apps' && c.auth === 'Bearer BUSINESS_TOKEN'), 'app subscribed to the WABA with the business token')
  const syncs = calls.filter(c => c.path === 'PN_1/smb_app_data').map(c => c.body.sync_type)
  ok(syncs.join(',') === 'smb_app_state_sync,history', 'contacts sync requested, then history')
  ok(conn.status === 'connected' && conn.displayPhoneNumber === '+92 300 0000000' && conn.verifiedName === 'Hidaya Online', 'number details stored')
  ok(conn.coexistence === true && conn.historySync?.requestedAt && !conn.historySync?.error, 'history sync marked requested')

  const stored = await WhatsappConnection.findOne({ key: 'default' }).select('+accessTokenEnc').lean()
  ok(stored.accessTokenEnc && stored.accessTokenEnc !== 'BUSINESS_TOKEN' && decryptSecret(stored.accessTokenEnc) === 'BUSINESS_TOKEN', 'token stored encrypted')

  let body
  await getConnection({}, { json: (b) => { body = b }, status: () => ({ json: (b) => { body = b } }) })
  ok(body?.connection?.phoneNumberId === 'PN_1' && !('accessTokenEnc' in body.connection), 'GET /connection never returns the token')
  ok(body?.configId && body?.appId === META_APP_ID, 'GET /connection hands the browser the app + config ids')

  console.log('\nNumber picked without an id')
  calls.length = 0
  conn = await connectWhatsappNumber({ ...base, phoneNumberId: '' })
  ok(conn.phoneNumberId === 'PN_1', 'the WABA\'s only number is used')

  console.log('\nWrong number')
  let err = null
  try { await connectWhatsappNumber({ ...base, phoneNumberId: 'PN_OTHER' }) } catch (e) { err = e }
  ok(err?.name === 'GraphError' && /not on the WhatsApp Business Account/.test(err.message), 'a number outside the WABA is refused')

  console.log('\nSync failure')
  failHistorySync = true
  conn = await connectWhatsappNumber({ ...base, phoneNumberId: 'PN_1' })
  ok(conn.status === 'connected' && /expired/.test(conn.historySync?.error) && !conn.contactsSync?.error, 'failed history request stored, connect still succeeds')
  failHistorySync = false

  console.log('\nExpired code')
  failExchange = true
  err = null
  try { await connectWhatsappNumber({ ...base, phoneNumberId: 'PN_1' }) } catch (e) { err = e }
  ok(err?.name === 'GraphError' && /expired/.test(err.message), 'Meta\'s error message surfaces')

  console.log('\nSending — test number fallback')
  await WhatsappConnection.deleteMany({})
  process.env.WHATSAPP_ACCESS_TOKEN = 'TEST_TOKEN'
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'PN_TEST'
  process.env.WHATSAPP_WABA_ID = 'WABA_TEST'
  const sender = await resolveSender()
  ok(sender?.source === 'test' && sender.phoneNumberId === 'PN_TEST', 'no connection → API Setup test number from env')

  const call = async (handler, body) => {
    let status = 200, out
    const res = { status(c) { status = c; return this }, json(b) { out = b; return this } }
    await handler({ body, userId: new mongoose.Types.ObjectId(), method: 'POST', path: '/' }, res)
    return { status, body: out }
  }

  calls.length = 0
  let r = await call(send, { to: '+92 300 123-4567', type: 'text', text: 'Class at 8 tonight' })
  const sent = calls.find(c => c.path === 'PN_TEST/messages')
  ok(r.status === 201 && sent?.auth === 'Bearer TEST_TOKEN' && sent.body.to === '923001234567' && sent.body.text.body === 'Class at 8 tonight', 'text sent to the digits-only number with the test token')
  const row = await WhatsappMessage.findOne({ wamid: r.body?.message?.wamid }).lean()
  ok(row?.direction === 'out' && row.status === 'accepted' && row.sentBy, 'outbound row stored under Meta\'s wamid, status accepted, with the sender')

  calls.length = 0
  r = await call(send, { to: '923001234567', type: 'template', templateName: 'class_reminder', params: ['Aisha', '8:00 PM'] })
  const tpl = calls.find(c => c.path === 'PN_TEST/messages')?.body?.template
  ok(r.status === 201 && tpl?.name === 'class_reminder' && tpl.language.code === 'en_US' && tpl.components?.[0]?.parameters?.map(p => p.text).join('|') === 'Aisha|8:00 PM', 'template sent with its body parameters')

  r = await call(send, { to: '0300 1234567', type: 'text', text: 'hi' })
  ok(r.status === 400, 'local-format number refused')

  console.log('\nTemplates')
  r = await call(addTemplate, { name: 'class_reminder', category: 'UTILITY', body: 'Hi {{1}}, class at {{2}}', examples: ['Aisha'] })
  ok(r.status === 400, 'missing example value refused')
  calls.length = 0
  r = await call(addTemplate, { name: 'class_reminder', category: 'UTILITY', body: 'Hi {{1}}, class at {{2}}', examples: ['Aisha', '8:00 PM'] })
  const created = calls.find(c => c.path === 'WABA_TEST/message_templates')?.body
  ok(r.status === 201 && r.body.template.status === 'PENDING', 'template submitted, PENDING')
  ok(created?.components?.[0]?.example?.body_text?.[0]?.join('|') === 'Aisha|8:00 PM' && created.language === 'en_US', 'examples sent with the body')
  r = await call(addTemplate, { name: 'Class Reminder', body: 'x' })
  ok(r.status === 400, 'invalid template name refused')
} finally {
  if (mongoose.connection.name === SMOKE_DB) await mongoose.connection.dropDatabase().catch(() => {})
  await mongoose.disconnect()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

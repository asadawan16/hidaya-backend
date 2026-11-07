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
//   - access-key connect (for the app owner's own number, where Embedded
//     Signup fails with #1690130): the key must be valid, for our app, with
//     both WhatsApp permissions; several numbers need an id; an expiring key
//     connects with a warning; the number's is_on_biz_app sets coexistence
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
  connectWhatsappNumber, connectWithAccessKey, disconnect, getConnection, send, addTemplate, resolveSender,
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
// debug_token answers, keyed by the token being inspected
const TOKENS = {
  SYSTEM_TOKEN: { app_id: '__APP__', is_valid: true, expires_at: 0, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management'] },
  EXPIRING_TOKEN: { app_id: '__APP__', is_valid: true, expires_at: 1893456000, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] },
  OTHER_APP_TOKEN: { app_id: '999', is_valid: true, expires_at: 0, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] },
  NO_SEND_TOKEN: { app_id: '__APP__', is_valid: true, expires_at: 0, scopes: ['whatsapp_business_management'] },
  REVOKED_TOKEN: { app_id: '__APP__', is_valid: false, expires_at: 0, scopes: [] },
}
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
  if (path === 'debug_token') {
    const d = TOKENS[url.searchParams.get('input_token')]
    return json(200, { data: d ? { ...d, app_id: d.app_id === '__APP__' ? META_APP_ID : d.app_id } : { is_valid: false } })
  }
  if (path === 'PN_1' && method === 'GET') {
    return json(200, { id: 'PN_1', display_phone_number: '+92 300 0000000', verified_name: 'Hidaya Online', quality_rating: 'GREEN', platform_type: 'CLOUD_API', is_on_biz_app: true })
  }
  if (path === 'WABA_2/phone_numbers') {
    return json(200, { data: [{ id: 'PN_1', display_phone_number: '+92 300 0000000' }, { id: 'PN_2', display_phone_number: '+92 300 1111111' }] })
  }
  if (path === 'WABA_EMPTY/phone_numbers') return json(200, { data: [] })
  if (path === 'WABA_2/subscribed_apps') return json(200, { success: true })
  if (path === 'PN_2/smb_app_data') return json(200, { success: true })
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

  console.log('\nAccess-key connect (app owner\'s own number)')
  calls.length = 0
  let manual = await connectWithAccessKey({ accessToken: 'SYSTEM_TOKEN', wabaId: 'WABA_1', phoneNumberId: '', userId: null })
  const dbg = calls.find(c => c.path === 'debug_token')
  ok(dbg?.query.input_token === 'SYSTEM_TOKEN' && dbg?.query.access_token === `${META_APP_ID}|smoke-app-secret`, 'key inspected with the app token')
  ok(!calls.some(c => c.path === 'oauth/access_token'), 'no code exchange')
  ok(calls.some(c => c.method === 'POST' && c.path === 'WABA_1/subscribed_apps' && c.auth === 'Bearer SYSTEM_TOKEN'), 'app subscribed to the WABA with the pasted key')
  ok(calls.filter(c => c.path === 'PN_1/smb_app_data').map(c => c.body.sync_type).join(',') === 'smb_app_state_sync,history', 'is_on_biz_app → coexistence, contacts + history sync requested')
  ok(manual.connection.status === 'connected' && manual.connection.connectMethod === 'manual' && manual.connection.coexistence === true && manual.warnings.length === 0, 'connected as manual, no warnings')
  const storedManual = await WhatsappConnection.findOne({ key: 'default' }).select('+accessTokenEnc').lean()
  ok(decryptSecret(storedManual.accessTokenEnc) === 'SYSTEM_TOKEN', 'pasted key stored encrypted')
  const manualSender = await resolveSender()
  ok(manualSender?.source === 'connected' && manualSender.token === 'SYSTEM_TOKEN', 'sending uses the connected number with the pasted key')

  manual = await connectWithAccessKey({ accessToken: 'EXPIRING_TOKEN', wabaId: 'WABA_1', phoneNumberId: 'PN_1', userId: null })
  ok(manual.connection.status === 'connected' && manual.warnings.some(w => /stops working/.test(w)), 'an expiring key connects, with a warning')

  const refused = async (args) => { try { await connectWithAccessKey({ wabaId: 'WABA_1', phoneNumberId: '', userId: null, ...args }); return null } catch (e) { return e } }
  err = await refused({ accessToken: 'REVOKED_TOKEN' })
  ok(err?.name === 'GraphError' && /isn't valid/.test(err.message), 'an invalid key is refused')
  err = await refused({ accessToken: 'OTHER_APP_TOKEN' })
  ok(err?.name === 'GraphError' && /different Meta app/.test(err.message), 'a key for another app is refused')
  err = await refused({ accessToken: 'NO_SEND_TOKEN' })
  ok(err?.name === 'GraphError' && /whatsapp_business_messaging/.test(err.message), 'a key without the messaging permission is refused, naming it')
  err = await refused({ accessToken: 'SYSTEM_TOKEN', wabaId: 'WABA_2' })
  ok(err?.name === 'GraphError' && /2 numbers/.test(err.message) && /PN_2/.test(err.message), 'several numbers and no id → asks for one, listing them')
  err = await refused({ accessToken: 'SYSTEM_TOKEN', wabaId: 'WABA_EMPTY' })
  ok(err?.name === 'GraphError' && /no phone number/.test(err.message), 'an account with no number is refused')
  manual = await connectWithAccessKey({ accessToken: 'SYSTEM_TOKEN', wabaId: 'WABA_2', phoneNumberId: 'PN_2', userId: null })
  ok(manual.connection.phoneNumberId === 'PN_2' && manual.connection.coexistence === true, 'the chosen number is connected (details lookup failure tolerated)')

  console.log('\nDisconnect — chats kept unless asked, then only that number\'s')
  const WhatsappChat = (await import('../models/WhatsappChat.js')).default
  const { syncChat } = await import('../utils/whatsappChats.js')
  await WhatsappMessage.deleteMany({})
  await WhatsappChat.deleteMany({})
  const at = (m) => new Date(Date.now() - m * 60_000)
  await WhatsappMessage.insertMany([
    // A wrote only to the number being disconnected (PN_2, connected above)
    { wamid: 'wamid.A1', direction: 'in', waId: '111', phoneNumberId: 'PN_2', text: 'old 1', timestamp: at(30) },
    { wamid: 'wamid.A2', direction: 'out', waId: '111', phoneNumberId: 'PN_2', text: 'old 2', timestamp: at(20) },
    // B wrote to both numbers
    { wamid: 'wamid.B1', direction: 'in', waId: '222', phoneNumberId: 'PN_OTHER', text: 'keep me', timestamp: at(40) },
    { wamid: 'wamid.B2', direction: 'in', waId: '222', phoneNumberId: 'PN_2', text: 'old 3', timestamp: at(10) },
    // C never used it
    { wamid: 'wamid.C1', direction: 'in', waId: '333', phoneNumberId: 'PN_OTHER', text: 'untouched', timestamp: at(5) },
  ])
  for (const w of ['111', '222', '333']) await syncChat(w)
  const callDisconnect = async (query) => {
    let status = 200, out
    const res = { status(c) { status = c; return this }, json(b) { out = b; return this } }
    await disconnect({ query, body: {}, userId: null, method: 'DELETE', path: '/connection' }, res)
    return { status, body: out }
  }

  let d = await callDisconnect({})
  ok(d.status === 200 && d.body.connection.status === 'disconnected' && d.body.deleted === null, 'plain disconnect')
  ok(await WhatsappMessage.countDocuments() === 5 && await WhatsappChat.countDocuments() === 3, 'without the option, every message and chat stays')

  await connectWithAccessKey({ accessToken: 'SYSTEM_TOKEN', wabaId: 'WABA_2', phoneNumberId: 'PN_2', userId: null })
  d = await callDisconnect({ deleteChats: '1' })
  ok(d.status === 200 && d.body.connection.status === 'disconnected', 'disconnect with the option')
  ok(d.body.deleted?.messages === 3 && d.body.deleted?.chats === 1, 'reports 3 messages and 1 chat removed')
  ok(await WhatsappMessage.countDocuments({ phoneNumberId: 'PN_2' }) === 0, 'every message of that number is gone')
  ok(!(await WhatsappChat.findOne({ waId: '111' })), 'a chat with only that number\'s messages is dropped')
  const chatB = await WhatsappChat.findOne({ waId: '222' }).populate('lastMessage').lean()
  ok(chatB?.lastMessage?.wamid === 'wamid.B1', 'a chat that also used another number stays, showing its own last message')
  ok(await WhatsappMessage.countDocuments({ waId: '333' }) === 1 && await WhatsappChat.exists({ waId: '333' }), 'other contacts untouched')
  await WhatsappMessage.deleteMany({})
  await WhatsappChat.deleteMany({})

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

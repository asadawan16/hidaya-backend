// Smoke test: WhatsApp contact names and messages typed on the office phone.
//   - phoneKey: one key for every way a number is written
//   - smb_message_echoes (typed on the phone) land as `out`, source 'app'
//   - smb_app_state_sync (the phone's saved contacts) names the chat; a
//     'remove' takes the name away
//   - an uploaded contacts file names chats; the phone's name outranks it,
//     a name typed in the portal outranks both, '' goes back
//   - search finds a chat by its saved name; staff never match a saved name
//     by digits; the WhatsApp page's messages carry savedName
//   - Number & setup: the webhook-field check, and turning the missing ones on
//     keeps the fields already on
// Meta is a stubbed global fetch. Runs against a THROWAWAY database
// (hidaya_whatsapp_contacts_smoke) and drops it. No server needed.
//
//   node scripts/smoke-whatsapp-contacts.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import WhatsappMessage from '../models/WhatsappMessage.js'
import WhatsappChat from '../models/WhatsappChat.js'
import WhatsappContact from '../models/WhatsappContact.js'
import { processWebhookPayload } from '../controllers/whatsappWebhookController.js'
import {
  listChats, getChatMessages, renameChat, importContactList, getContactSummary,
} from '../controllers/portalWhatsappChatController.js'
import { listMessages, getWebhookFields, enableWebhookFields } from '../controllers/portalWhatsappController.js'
import { phoneKey } from '../utils/whatsappContacts.js'

process.env.WHATSAPP_ACCESS_TOKEN = 'TEST_TOKEN'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'PN_TEST'
process.env.WHATSAPP_WABA_ID = 'WABA_TEST'
process.env.WHATSAPP_APP_SECRET = 'APP_SECRET_TEST'
process.env.WHATSAPP_VERIFY_TOKEN = 'VERIFY_TEST'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }

// ── Fake Graph API ──────────────────────────────────────────────────────────
let appFields = ['messages', 'account_update']
let callbackUrl = 'https://example.test/api/whatsapp/webhook'
const subscribeCalls = []
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  const path = url.pathname.replace(/^\/v[\d.]+\//, '')
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  if (path.endsWith('/subscriptions') && method === 'GET') {
    return json(200, { data: callbackUrl ? [{ object: 'whatsapp_business_account', callback_url: callbackUrl, active: true, fields: appFields.map(name => ({ name, version: 'v23.0' })) }] : [] })
  }
  if (path.endsWith('/subscriptions') && method === 'POST') {
    subscribeCalls.push(Object.fromEntries(url.searchParams))
    appFields = url.searchParams.get('fields').split(',')
    return json(200, { success: true })
  }
  if (path === 'WABA_TEST/message_templates') return json(200, { data: [] })
  return json(404, { error: { message: `unstubbed ${method} ${path}` } })
}

const SMOKE_DB = 'hidaya_whatsapp_contacts_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
await mongoose.connection.dropDatabase()
await Promise.all([WhatsappMessage.syncIndexes(), WhatsappChat.syncIndexes(), WhatsappContact.syncIndexes()])

const call = async (handler, req) => {
  let status = 200, out
  const res = { status(c) { status = c; return this }, json(b) { out = b; return this }, set() { return this }, send(b) { out = b; return this } }
  await handler({ method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: {}, ...req }, res)
  return { status, body: out }
}
const adminId = new mongoose.Types.ObjectId()
const FULL = { userId: adminId, user: { _id: adminId }, userPermissions: new Set(['whatsapp.chat', 'whatsapp.inbox', 'whatsapp.manage']) }
const STAFF = { userId: new mongoose.Types.ObjectId(), user: {}, userPermissions: new Set(['whatsapp.chat']) }

let seq = 0
const ts = () => String(Math.floor(Date.now() / 1000) - 60 + (++seq))
const webhook = (field, value) => processWebhookPayload({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field, value: { metadata: { phone_number_id: 'PN_TEST' }, ...value } }] }],
})
const inbound = (from, profile, body) => webhook('messages', {
  contacts: [{ wa_id: from, profile: { name: profile } }],
  messages: [{ id: `wamid.IN_${++seq}`, from, timestamp: ts(), type: 'text', text: { body } }],
})
const chatOf = (waId) => WhatsappChat.findOne({ waId }).lean()
const listNames = async (who, q = '') => (await call(listChats, { ...who, query: { q } })).body.chats.map(c => c.name)

const AHMED = '923001234567'
const SARA = '16315550123'
const BILAL = '447700900111'

try {
  console.log('\nphoneKey')
  ok(['+92 300 1234567', '0300-1234567', '00923001234567', AHMED].every(n => phoneKey(n) === '3001234567'), 'every way of writing one number gives one key')
  ok(phoneKey('12345') === '' && phoneKey('') === '', 'a short string is not a number')

  console.log('\nMessages typed on the office phone')
  await inbound(AHMED, 'A.R', 'Assalamu alaikum')
  await webhook('smb_message_echoes', {
    message_echoes: [{ id: 'wamid.ECHO_1', from: '16313558368', to: AHMED, timestamp: ts(), type: 'text', text: { body: 'Walaikum salam, sent from the phone' } }],
  })
  const echo = await WhatsappMessage.findOne({ wamid: 'wamid.ECHO_1' }).lean()
  ok(echo?.direction === 'out' && echo.source === 'app' && echo.waId === AHMED, 'an echo is stored as sent from the phone app')
  let thread = await call(getChatMessages, { ...FULL, params: { id: String((await chatOf(AHMED))._id) } })
  ok(thread.body.messages.some(m => m.source === 'app' && /from the phone/.test(m.text)), 'and shows in the chat')
  ok((await listNames(FULL))[0] === 'A.R', 'with no saved name, the chat shows the WhatsApp profile name')

  console.log("\nThe phone's saved contacts")
  await webhook('smb_app_state_sync', {
    state_sync: [{ type: 'contact', action: 'add', contact: { phone_number: `+${AHMED}`, full_name: 'Ahmed Raza Parent', first_name: 'Ahmed' }, metadata: { timestamp: ts() } }],
  })
  let chat = await chatOf(AHMED)
  ok(chat.savedName === 'Ahmed Raza Parent' && chat.nameSource === 'phone', 'a synced contact names the chat')
  ok((await listNames(FULL))[0] === 'Ahmed Raza Parent', 'the list shows the phone name')
  ok((await listNames(FULL, 'raza parent')).includes('Ahmed Raza Parent'), 'search finds it by the saved name')
  ok((await listNames(STAFF, 'raza')).includes('Ahmed Raza Parent'), 'staff see and search the saved name too')

  console.log('\nAn uploaded contacts file')
  await inbound(SARA, '', 'Hello, is there a trial class?')
  await inbound(BILAL, 'Bilal', 'Fee query')
  let r = await call(importContactList, {
    ...FULL,
    body: { contacts: [
      { name: 'Sara Mom (USA)', phone: '+1 (631) 555-0123' },
      { name: 'Ahmed from file', phone: '0300 1234567' },
      { name: 'Nobody', phone: '12' },
      { name: '', phone: '+44 7700 900222' },
    ] },
  })
  ok(r.status === 200 && r.body.added === 1 && r.body.updated === 1 && r.body.skipped === 2, 'one new contact, one already known from the phone, the unusable rows skipped')
  ok((await chatOf(SARA)).savedName === 'Sara Mom (USA)' && (await chatOf(SARA)).nameSource === 'import', 'the file names a chat that had no name')
  ok((await chatOf(AHMED)).savedName === 'Ahmed Raza Parent', "but the phone's name still wins over the file")
  r = await call(importContactList, { ...FULL, body: { contacts: [{ name: 'Sara Again', phone: '16315550123' }] } })
  ok(r.body.unchanged === 1 && (await chatOf(SARA)).savedName === 'Sara Mom (USA)', 'a second file leaves an existing name alone…')
  r = await call(importContactList, { ...FULL, body: { contacts: [{ name: 'Sara Again', phone: '16315550123' }], overwrite: true } })
  ok(r.body.updated === 1 && (await chatOf(SARA)).savedName === 'Sara Again', '…unless told to replace names')
  ok(r.body.summary?.total >= 2 && r.body.summary.imported >= 2 && r.body.summary.fromPhone === 1, 'the summary counts the names by where they came from')
  r = await call(importContactList, { ...STAFF, body: { contacts: [{ name: 'x', phone: '923001234567' }] } })
  ok(r.status === 200, '(the import route itself is guarded by inboxOnly — checked below)')

  console.log('\nA name typed in the portal')
  const ahmedId = String((await chatOf(AHMED))._id)
  r = await call(renameChat, { ...FULL, params: { id: ahmedId }, body: { name: '  Ahmed Raza — Hifz, Sat class  ' } })
  ok(r.status === 200 && r.body.savedName === 'Ahmed Raza — Hifz, Sat class' && r.body.nameSource === 'portal', 'the portal name outranks the phone')
  ok((await listNames(FULL, 'hifz')).includes('Ahmed Raza — Hifz, Sat class'), 'and is searchable')
  r = await call(renameChat, { ...FULL, params: { id: ahmedId }, body: { name: '' } })
  ok(r.body.savedName === 'Ahmed Raza Parent' && r.body.nameSource === 'phone', 'clearing it goes back to the phone name')
  r = await call(renameChat, { ...FULL, params: { id: ahmedId }, body: { name: 'x'.repeat(200) } })
  ok(r.status === 400, 'an over-long name is refused')

  console.log('\nStaff and numbers')
  await call(renameChat, { ...FULL, params: { id: String((await chatOf(BILAL))._id) }, body: { name: 'Bilal 07700 900111' } })
  const staffList = (await call(listChats, STAFF)).body.chats
  const bilalForStaff = staffList.find(c => c.contactName === 'Bilal' || c.name === 'Bilal')
  ok(bilalForStaff && !/\d{6}/.test(bilalForStaff.name) && !bilalForStaff.savedName, 'staff never get a saved name with a number in it')
  ok(!(await listNames(STAFF, '0770090')).length, 'staff cannot find a chat by digits in a saved name')
  ok((await listNames(FULL, '0770090')).length === 1, 'the full inbox can — and a local-style number finds the international one')

  console.log('\nContact removed on the phone')
  await webhook('smb_app_state_sync', { state_sync: [{ type: 'contact', action: 'remove', contact: { phone_number: AHMED } }] })
  chat = await chatOf(AHMED)
  ok(chat.savedName === 'Ahmed from file' && chat.nameSource === 'import', 'its phone name goes, and the file name shows again')

  console.log('\nThe WhatsApp page')
  const page = (await call(listMessages, { ...FULL, query: {} })).body
  ok(page.messages.some(m => m.waId === SARA && m.savedName === 'Sara Again'), 'messages carry the saved name for the conversation chips')
  const summary = (await call(getContactSummary, FULL)).body
  ok(summary.chats === 3 && summary.namedChats === 3, 'the summary knows how many chats have a name')

  console.log('\nWebhook fields (Number & setup)')
  r = await call(getWebhookFields, FULL)
  ok(r.status === 200 && r.body.missing.join() === 'smb_message_echoes,smb_app_state_sync,history', 'reports the three phone fields as off')
  r = await call(enableWebhookFields, FULL)
  const sent = subscribeCalls[0] || {}
  ok(r.status === 200 && r.body.missing.length === 0, 'turning them on leaves nothing missing')
  ok(sent.callback_url === callbackUrl && sent.verify_token === 'VERIFY_TEST' && sent.object === 'whatsapp_business_account', 'keeps the callback address and sends the verify token')
  ok(['messages', 'account_update', 'smb_message_echoes', 'smb_app_state_sync', 'history'].every(f => sent.fields.split(',').includes(f)), 'keeps the fields that were already on')
  callbackUrl = ''
  r = await call(enableWebhookFields, FULL)
  ok(r.status === 409, 'with no webhook address in the Meta app, it says so instead')

  console.log('\nRoutes')
  const { default: chatRouter } = await import('../routes/portalWhatsappChatRoutes.js')
  const guarded = (path, method) => chatRouter.stack.find(l => l.route?.path === path && l.route.methods[method])?.route.stack.length > 1
  ok(guarded('/contacts/import', 'post') && guarded('/contacts/summary', 'get') && guarded('/:id/name', 'put'), 'import, summary and rename sit behind the full-inbox guard')
} catch (err) {
  fail++
  console.error(err)
} finally {
  await mongoose.connection.dropDatabase()
  await mongoose.disconnect()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

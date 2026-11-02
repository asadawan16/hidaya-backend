// Smoke test for WhatsApp Chats (controllers/portalWhatsappChatController.js):
// the staff chat with hidden numbers + fee filtering, and the admin inbox.
//
// Covers:
//   - default roles: staff roles get whatsapp.chat, only admin gets whatsapp.inbox
//   - the fee filter (English, Roman Urdu, Urdu) and what it leaves alone
//   - staff view: no contact number anywhere in a response, fee messages arrive
//     as content-free placeholders, digit searches can't probe a number,
//     a profile name that is a number is dropped, fee media refused
//   - full view: numbers, every message, media relay, templates, file upload
//   - unread: shared across the team, staff never clear a fee message,
//     history replays never count, read receipts go to WhatsApp
//   - sending: 24-hour window (ours and Meta's 131047), staff can't send
//     fee talk or templates, template values filled in
//   - the chat list stays derived: rebuilt from the messages alone
//
// Meta is a stubbed global fetch. Runs against a THROWAWAY database
// (hidaya_whatsapp_chats_smoke) and drops it. No server or Meta account needed.
// Run: node scripts/smoke-whatsapp-chats.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import User from '../models/User.js'
import Role from '../models/Role.js'
import Student from '../models/Student.js'
import WhatsappMessage from '../models/WhatsappMessage.js'
import WhatsappChat from '../models/WhatsappChat.js'
import { effectivePermissions } from '../middleware/portalAuth.js'
import { DEFAULT_ROLE_PERMISSIONS } from '../config/permissions.js'
import { processWebhookPayload } from '../controllers/whatsappWebhookController.js'
import {
  listChats, getChatMessages, readChat, sendChatMessage, sendChatMedia, getChatMedia, listChatTemplates,
} from '../controllers/portalWhatsappChatController.js'
import { rebuildWhatsappChats } from '../utils/whatsappChats.js'
import { mentionsFees, isFeeMessage } from '../utils/feeFilter.js'

process.env.WHATSAPP_ACCESS_TOKEN = 'TEST_TOKEN'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'PN_TEST'
process.env.WHATSAPP_WABA_ID = 'WABA_TEST'
if (!process.env.MFA_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY.length !== 64) {
  process.env.MFA_ENCRYPTION_KEY = 'a'.repeat(64)
}

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }

// ── Fake Graph API ──────────────────────────────────────────────────────────
const sends = [], readReceipts = [], uploads = []
let seqOut = 0
let mode = 'ok' // ok | reengage
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  const path = url.pathname.replace(/^\/v[\d.]+\//, '')
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.hostname === 'lookaside.fbsbx.com') {
    return new Response(Buffer.from('JPEGDATA'), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
  }
  if (path === 'WABA_TEST/message_templates' && method === 'GET') {
    return json(200, {
      data: [
        { name: 'class_reminder', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: "Assalamu alaikum! {{1}}'s class is due at {{2}} today." }] },
        { name: 'fee_reminder', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Your fee of {{1}} is due this week.' }] },
        { name: 'pending_one', language: 'en_US', status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi' }] },
      ],
    })
  }
  if (path === 'PN_TEST/messages' && method === 'POST') {
    const body = JSON.parse(init.body)
    if (body.status === 'read') { readReceipts.push(body.message_id); return json(200, { success: true }) }
    if (mode === 'reengage') return json(400, { error: { message: 'Re-engagement message', code: 131047 } })
    sends.push(body)
    return json(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT_${++seqOut}` }] })
  }
  if (path === 'PN_TEST/media' && method === 'POST') {
    uploads.push(init.body)
    return json(200, { id: 'MEDIA_UP_1' })
  }
  if (path === 'MEDIA_IN_1' || path === 'MEDIA_IN_2') {
    return json(200, { url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${path}`, mime_type: 'image/jpeg' })
  }
  if (path === 'MEDIA_GONE') return json(404, { error: { message: 'Media not found', code: 100 } })
  return json(404, { error: { message: `unstubbed ${method} ${path}` } })
}

const SMOKE_DB = 'hidaya_whatsapp_chats_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
await mongoose.connection.dropDatabase()
await Promise.all([WhatsappMessage.syncIndexes(), WhatsappChat.syncIndexes(), User.syncIndexes()])

const call = async (handler, req) => {
  let status = 200, out, headers = {}
  const res = {
    status(c) { status = c; return this },
    json(b) { out = b; return this },
    set(h) { Object.assign(headers, h); return this },
    send(b) { out = b; return this },
  }
  await handler({ method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: {}, ...req }, res)
  return { status, body: out, headers }
}

// Webhook helpers
let seqIn = 0
const nowTs = (agoSec = 0) => String(Math.floor(Date.now() / 1000) - agoSec)
const inbound = (from, name, messages) => processWebhookPayload({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN_TEST' }, contacts: [{ wa_id: from, profile: { name } }], messages } }] }],
})
const txt = (from, body, agoSec = 0) => ({ id: `wamid.IN_${++seqIn}`, from, timestamp: nowTs(agoSec), type: 'text', text: { body } })
const media = (from, type, payload, agoSec = 0) => ({ id: `wamid.IN_${++seqIn}`, from, timestamp: nowTs(agoSec), type, [type]: payload })

const MOTHER = '447700900999'
const LEAD = '923331234567'
const ODD = '15550001111'
const OLD = '923009998888'
const NUMBERS = [MOTHER, '7700900999', LEAD, '3331234567', ODD, OLD]

try {
  // ── Fee filter ────────────────────────────────────────────────────────────
  console.log('\nFee filter')
  const fees = ['Fee for November?', 'I have paid', 'Rs 5000 bhej diye', '$40 sent', 'fees jama karwa di hai', 'paisay bhej diye',
    'فیس جمع کروا دی ہے', 'ادائیگی ہو گئی', '5 hazar bhej diye', 'jazzcash kar diya', 'can I pay tomorrow', 'PKR5000']
  const plain = ['Assalamu alaikum', 'Please pay attention in class', 'Class is due at 8 PM', 'Report card kab milega?',
    'Aaj sar mein dard hai', 'نماز ادا کر کے آتا ہوں', 'جمعہ کو چھٹی ہے', 'He feels sick today', 'Homework done, 5 pages']
  ok(fees.every(mentionsFees), `catches fee talk (${fees.length} samples: English, Roman Urdu, Urdu)`)
  ok(!plain.some(mentionsFees), `leaves ordinary class talk alone (${plain.length} samples)`)
  ok(isFeeMessage({ templateName: 'fee_reminder' }) && isFeeMessage({ media: { filename: 'Fee Receipt.pdf' } }), 'template names and file names count')

  // ── Roles ─────────────────────────────────────────────────────────────────
  console.log('\nDefault roles')
  ok(['principal', 'coordinator', 'qci', 'qcm'].every(k => DEFAULT_ROLE_PERMISSIONS[k].includes('whatsapp.chat')), 'staff roles get whatsapp.chat')
  ok(['principal', 'coordinator', 'qci', 'qcm', 'tutor'].every(k => !DEFAULT_ROLE_PERMISSIONS[k].includes('whatsapp.inbox')), 'only admin-level roles get whatsapp.inbox')
  ok(DEFAULT_ROLE_PERMISSIONS.admin.includes('whatsapp.inbox') && DEFAULT_ROLE_PERMISSIONS.admin.includes('whatsapp.chat'), 'admin gets both')
  ok(!DEFAULT_ROLE_PERMISSIONS.tutor.includes('whatsapp.chat'), 'tutors get neither')

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const roles = {}
  for (const key of ['admin', 'qci']) roles[key] = await Role.create({ key, name: key, permissions: DEFAULT_ROLE_PERMISSIONS[key], system: true })
  const adminUser = await User.create({ email: 'admin@x.test', password: 'secret123', displayName: 'Admin', roles: [roles.admin._id] })
  const qciUser = await User.create({ email: 'qci@x.test', password: 'secret123', displayName: 'Ayesha QCI', roles: [roles.qci._id] })
  const loadReq = async (userId) => {
    const user = await User.findById(userId).populate('roles').lean()
    return { user, userId: user._id, userPermissions: effectivePermissions(user) }
  }
  const staff = await loadReq(qciUser._id)
  const admin = await loadReq(adminUser._id)

  const hamza = await Student.create({
    name: 'Hamza Raza', rollNo: 'HID518', status: 'active', country: 'United Kingdom', timezone: 'Europe/London',
    whatsappNumber: '+44 7700 900123',
    guardians: [{ relation: 'mother', name: 'Sara', phone: '+44 7700 900999', isWhatsappRecipient: true }],
  })

  await inbound(MOTHER, 'Sara Raza', [
    txt(MOTHER, "Assalamu alaikum, can Hamza's class move to 9 PM tomorrow?", 300),
    txt(MOTHER, 'November fees sent through JazzCash', 240),
    media(MOTHER, 'image', { id: 'MEDIA_IN_1', mime_type: 'image/jpeg', caption: "Today's homework" }, 180),
    media(MOTHER, 'document', { id: 'MEDIA_IN_2', mime_type: 'application/pdf', filename: 'Fee Receipt.pdf' }, 120),
  ])
  await inbound(LEAD, 'Imran', [txt(LEAD, 'Do you teach Tajweed online?', 2 * 86400)])
  await inbound(ODD, '+1 555 000 1111', [media(ODD, 'image', { id: 'MEDIA_GONE', mime_type: 'image/jpeg' }, 60)])
  await processWebhookPayload({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'history', value: { metadata: { phone_number_id: 'PN_TEST' }, history: [{ metadata: { progress: 100 }, threads: [{ id: OLD, messages: [{ id: 'wamid.H1', from: OLD, timestamp: nowTs(90 * 86400), type: 'text', text: { body: 'Old chat' } }] }] }] } }] }],
  })

  // ── Staff list ────────────────────────────────────────────────────────────
  console.log('\nStaff view — chat list')
  let r = await call(listChats, staff)
  const chatOf = (list, name) => list.find(c => c.name === name)
  let blob = JSON.stringify(r.body)
  ok(r.status === 200 && r.body.view === 'staff' && r.body.chats.length === 4, 'four chats, staff view')
  ok(!NUMBERS.some(n => blob.includes(n)), 'no contact number anywhere in the response')
  ok(!/jazzcash|Fee Receipt/i.test(blob), 'no fee message content in the response')
  const hamzaStaff = chatOf(r.body.chats, 'Hamza Raza')
  ok(hamzaStaff?.label === 'Mother' && hamzaStaff.student?.rollNo === 'HID518', 'linked to the student, shown as Mother')
  ok(hamzaStaff?.unread === 2, 'unread counts only what staff can see (2 of 4)')
  ok(hamzaStaff?.preview?.hidden === 'fees' && hamzaStaff.preview.text === undefined, 'a fee message as the preview is a placeholder')
  ok(chatOf(r.body.chats, 'Imran')?.window.open === false, 'a contact silent for 2 days: reply window closed')
  ok(!!chatOf(r.body.chats, 'Unknown contact'), 'a profile name that is a phone number is not shown')
  const oldChat = r.body.chats.find(c => c.name === 'Unknown contact' && c.unread === 0)
  ok(!!oldChat, 'the history replay chat is there with nothing unread')

  r = await call(listChats, { ...staff, query: { q: 'HID518' } })
  ok(r.body.chats.length === 1 && r.body.chats[0].name === 'Hamza Raza', 'search by roll number')
  r = await call(listChats, { ...staff, query: { q: '900999' } })
  ok(r.body.chats.length === 0, 'staff cannot find a chat by digits of its number')
  r = await call(listChats, { ...staff, query: { filter: 'students' } })
  ok(r.body.chats.length === 1, 'Students filter')
  r = await call(listChats, { ...staff, query: { filter: 'unread' } })
  ok(r.body.chats.length === 3 && r.body.chats.every(c => c.unread > 0), 'Unread filter skips the history chat')

  // ── Full list ─────────────────────────────────────────────────────────────
  console.log('\nFull view — chat list')
  r = await call(listChats, admin)
  const hamzaFull = chatOf(r.body.chats, 'Hamza Raza')
  ok(r.body.view === 'full' && hamzaFull?.waId === MOTHER, 'full view carries the number')
  ok(hamzaFull?.unread === 4 && hamzaFull.preview?.media?.filename === 'Fee Receipt.pdf', 'every message counts and shows')
  ok(r.body.chats.find(c => c.waId === ODD)?.name === '+1 555 000 1111', 'full view keeps a numeric profile name as given')
  r = await call(listChats, { ...admin, query: { q: '900999' } })
  ok(r.body.chats.length === 1, 'full view finds a chat by digits')

  // ── Thread ────────────────────────────────────────────────────────────────
  console.log('\nThread')
  const hamzaChat = await WhatsappChat.findOne({ waId: MOTHER }).lean()
  const params = { id: String(hamzaChat._id) }
  r = await call(getChatMessages, { ...staff, params })
  blob = JSON.stringify(r.body)
  const hidden = r.body.messages.filter(m => m.hidden === 'fees')
  ok(r.body.messages.length === 4 && hidden.length === 2, 'staff: 4 messages, 2 hidden')
  ok(hidden.every(m => m.text === undefined && m.media === undefined), 'a hidden message carries no text and no file')
  ok(!NUMBERS.some(n => blob.includes(n)) && r.body.chat.waId === undefined, 'staff thread: no number')
  ok(r.body.chat.window.open && !r.body.chat.canSendTemplates && !r.body.chat.canSendMedia, 'staff: text replies only')
  const photo = r.body.messages.find(m => m.type === 'image')
  ok(photo?.media?.available && photo.text === "Today's homework", 'a photo with an ordinary caption is visible')

  r = await call(getChatMessages, { ...admin, params })
  ok(r.body.messages.every(m => !m.hidden) && r.body.chat.waId === MOTHER && r.body.chat.canSendMedia, 'full view: everything')
  const feeDoc = r.body.messages.find(m => m.type === 'document')

  // ── Media ─────────────────────────────────────────────────────────────────
  console.log('\nMedia')
  r = await call(getChatMedia, { ...staff, params: { messageId: String(photo._id) } })
  ok(r.status === 200 && Buffer.isBuffer(r.body) && r.body.toString() === 'JPEGDATA' && r.headers['Content-Type'] === 'image/jpeg', 'staff can open a homework photo')
  r = await call(getChatMedia, { ...staff, params: { messageId: String(feeDoc._id) } })
  ok(r.status === 403, 'staff cannot download the fee receipt')
  r = await call(getChatMedia, { ...admin, params: { messageId: String(feeDoc._id) } })
  ok(r.status === 200, 'the admin can')
  const gone = await WhatsappMessage.findOne({ waId: ODD }).lean()
  r = await call(getChatMedia, { ...admin, params: { messageId: String(gone._id) } })
  ok(r.status === 410, 'expired media: 410')

  // ── Read state ────────────────────────────────────────────────────────────
  console.log('\nUnread')
  r = await call(readChat, { ...staff, params })
  ok(r.body.marked === 2, 'staff opening the chat marks the 2 they can see')
  // The read receipt is fire-and-forget — give it up to 3 s to land
  for (let i = 0; i < 30 && !readReceipts.length; i++) await new Promise(res => setTimeout(res, 100))
  ok(readReceipts.length === 1 && readReceipts[0] === 'wamid.IN_3', 'one read receipt, for the newest message staff could see')
  ok((await WhatsappChat.findById(hamzaChat._id).lean()).unreadCount === 2, 'the 2 fee messages stay unread for the admin')
  r = await call(listChats, staff)
  ok(chatOf(r.body.chats, 'Hamza Raza').unread === 0, 'staff see nothing unread now')
  r = await call(readChat, { ...admin, params })
  ok(r.body.marked === 2 && (await WhatsappChat.findById(hamzaChat._id).lean()).unreadCount === 0, 'the admin opening it clears the rest')

  // ── Sending ───────────────────────────────────────────────────────────────
  console.log('\nSending')
  r = await call(sendChatMessage, { ...staff, params, body: { text: 'Wa alaikum assalam, yes, 9 PM works.' } })
  ok(r.status === 201 && sends.at(-1)?.to === MOTHER && sends.at(-1)?.text?.body.startsWith('Wa alaikum'), 'staff reply goes to the contact')
  ok(r.body.message.sentBy?.name === 'Ayesha QCI' && !JSON.stringify(r.body).includes(MOTHER), 'reply shows who sent it, never the number')
  const stored = await WhatsappMessage.findOne({ wamid: `wamid.OUT_${seqOut}` }).lean()
  ok(String(stored?.sentBy) === String(qciUser._id) && String(stored.studentId) === String(hamza._id), 'stored with the sender and the student')

  const before = sends.length
  r = await call(sendChatMessage, { ...staff, params, body: { text: 'The fee is Rs 5000 this month' } })
  ok(r.status === 422 && r.body.code === 'fee_topic' && sends.length === before, 'staff cannot send fee talk')
  r = await call(sendChatMessage, { ...staff, params, body: { type: 'template', templateName: 'class_reminder', params: ['a', 'b'] } })
  ok(r.status === 403, 'staff cannot send templates')

  const leadChat = await WhatsappChat.findOne({ waId: LEAD }).lean()
  r = await call(sendChatMessage, { ...staff, params: { id: String(leadChat._id) }, body: { text: 'Yes we do!' } })
  ok(r.status === 409 && r.body.code === 'window_closed' && sends.length === before, 'window closed: free text refused before calling Meta')

  r = await call(listChatTemplates, admin)
  ok(r.body.templates.map(t => t.name).join() === 'class_reminder,fee_reminder', 'only approved templates are offered')
  r = await call(sendChatMessage, { ...admin, params: { id: String(leadChat._id) }, body: { type: 'template', templateName: 'fee_reminder', params: [] } })
  ok(r.status === 400, 'template values are required')
  r = await call(sendChatMessage, { ...admin, params: { id: String(leadChat._id) }, body: { type: 'template', templateName: 'fee_reminder', params: ['Rs 5,000'] } })
  ok(r.status === 201 && sends.at(-1)?.template?.components?.[0]?.parameters?.[0]?.text === 'Rs 5,000', 'admin sends a template outside the window')
  ok(r.body.message.text === 'Your fee of Rs 5,000 is due this week.', 'stored as the text the contact saw')
  r = await call(getChatMessages, { ...staff, params: { id: String(leadChat._id) } })
  ok(r.body.messages.at(-1)?.hidden === 'fees', '...and staff see it hidden')

  mode = 'reengage'
  r = await call(sendChatMessage, { ...admin, params, body: { text: 'One more thing' } })
  ok(r.status === 409 && r.body.code === 'window_closed', "Meta's 131047 becomes the window-closed message")
  mode = 'ok'

  // Legacy template rows that stored only the values
  await WhatsappMessage.create({
    wamid: 'wamid.LEGACY', direction: 'out', waId: MOTHER, type: 'template', templateName: 'class_reminder',
    text: 'Hamza · 8:30 PM', status: 'read', timestamp: new Date(),
  })
  r = await call(getChatMessages, { ...staff, params })
  ok(r.body.messages.at(-1)?.text === "Assalamu alaikum! Hamza's class is due at 8:30 PM today.", 'a template stored as values reads as the full message')

  // ── Media upload ──────────────────────────────────────────────────────────
  console.log('\nMedia upload')
  const png = Buffer.from('89504e47', 'hex')
  r = await call(sendChatMedia, { ...admin, params, headers: { 'content-type': 'image/png' }, query: { filename: 'hw.png', caption: 'Well done Hamza!' }, body: png })
  ok(r.status === 201 && uploads.length === 1 && sends.at(-1)?.image?.id === 'MEDIA_UP_1' && sends.at(-1).image.caption === 'Well done Hamza!', 'admin sends a photo')
  ok(r.body.message.type === 'image' && r.body.message.media?.available, 'stored as an image with its media id')
  r = await call(sendChatMedia, { ...admin, params, headers: { 'content-type': 'application/zip' }, body: png })
  ok(r.status === 415, 'unsupported file type refused')
  r = await call(sendChatMedia, { ...admin, params, headers: { 'content-type': 'image/jpeg' }, body: Buffer.alloc(6 * 1024 * 1024) })
  ok(r.status === 413, 'photo over 5 MB refused')

  // ── Statuses + derived list ───────────────────────────────────────────────
  console.log('\nStatuses + rebuild')
  await processWebhookPayload({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.OUT_1', status: 'delivered', timestamp: nowTs() }] } }] }] })
  ok((await WhatsappMessage.findOne({ wamid: 'wamid.OUT_1' }).lean()).status === 'delivered', 'delivery tick recorded')

  const snapshot = await WhatsappChat.find().sort({ waId: 1 }).select('waId unreadCount lastMessage studentId contactName -_id').lean()
  await WhatsappChat.deleteMany({})
  const built = await rebuildWhatsappChats()
  const rebuilt = await WhatsappChat.find().sort({ waId: 1 }).select('waId unreadCount lastMessage studentId contactName -_id').lean()
  ok(built === 4 && JSON.stringify(rebuilt) === JSON.stringify(snapshot), 'the chat list rebuilds identically from the messages')

  r = await call(getChatMessages, { ...staff, params: { id: 'nope' } })
  ok(r.status === 404, 'bad chat id: 404')
} catch (err) {
  fail++
  console.error(err)
} finally {
  await mongoose.connection.dropDatabase()
  await mongoose.disconnect()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

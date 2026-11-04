// Smoke test for the WhatsApp page's "Send a message" and its plain-English
// errors (controllers/portalWhatsappController.js + utils/whatsappErrors.js).
//
// Covers:
//   - sending to a STUDENT instead of a typed number: the guardian marked as
//     the WhatsApp recipient wins, a local 03xx number becomes +92 for a
//     Pakistani student, the row is linked to the student, and the response
//     says who it went to (Mother, Student…)
//   - a student with no number / an unusable number gets a sentence telling
//     staff what to fix, not a Meta error
//   - a typed number still works, and a local-format one is still refused
//   - Meta's error codes come back in plain words (131042 billing, 131026
//     not on WhatsApp, 132001 template missing); an unknown code keeps Meta's text
//   - the message list carries a plain `failedReason` and a failed count
//   - template language is validated
//
// Meta is a stubbed global fetch; uses the API Setup test-number sender, so no
// Meta account is needed. THROWAWAY database (hidaya_whatsapp_send_smoke),
// dropped afterwards. Run: node scripts/smoke-whatsapp-send.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import '../models/User.js'
import Student from '../models/Student.js'
import WhatsappMessage from '../models/WhatsappMessage.js'
import { send, listMessages, addTemplate, getTemplates } from '../controllers/portalWhatsappController.js'
import { plainWhatsappError, plainFailure } from '../utils/whatsappErrors.js'

process.env.WHATSAPP_ACCESS_TOKEN = 'TEST_TOKEN'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'PN_TEST'
process.env.WHATSAPP_WABA_ID = 'WABA_TEST'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }

// ── Fake Graph API ──────────────────────────────────────────────────────────
const calls = []
let seq = 0
let nextError = null // { code, message } — the next send fails with it
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const path = url.pathname.replace(/^\/v[\d.]+\//, '')
  const body = init.body ? JSON.parse(init.body) : null
  calls.push({ path, body })
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  if (path === 'PN_TEST/messages') {
    if (nextError) { const e = nextError; nextError = null; return json(400, { error: e }) }
    return json(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.S_${++seq}` }] })
  }
  if (path === 'WABA_TEST/message_templates') {
    if (nextError) { const e = nextError; nextError = null; return json(401, { error: e }) }
    return init.method === 'POST' ? json(200, { id: 'TPL_1', status: 'PENDING', category: 'UTILITY' }) : json(200, { data: [] })
  }
  return json(404, { error: { message: `unstubbed ${path}` } })
}

const call = async (fn, req) => {
  let status = 200, out
  const res = { status(c) { status = c; return this }, json(b) { out = b; return this } }
  await fn({ userId: null, ip: '127.0.0.1', headers: {}, ...req }, res)
  return { status, body: out }
}

const SMOKE_DB = 'hidaya_whatsapp_send_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}

try {
  await mongoose.connection.dropDatabase()
  const ayesha = await Student.create({
    name: 'Ayesha Khan', rollNo: 'HID900', country: 'Pakistan', whatsappNumber: '+44 7700 900123',
    guardians: [{ name: 'Sara Khan', relation: 'mother', phone: '0300 1234567', isWhatsappRecipient: true }],
  })
  const bilal = await Student.create({ name: 'Bilal Ahmed', rollNo: 'HID901', country: 'United Kingdom' })
  const omar = await Student.create({ name: 'Omar Ali', rollNo: 'HID902', country: 'United Kingdom', phone: '12' })

  console.log('\nSend to a student')
  let r = await call(send, { body: { studentId: String(ayesha._id), type: 'template', templateName: 'class_reminder', params: ['Ayesha'] } })
  ok(r.status === 201, 'sent (201)')
  ok(calls.at(-1).body?.to === '923001234567', "went to the mother's number, 0300… converted to +92")
  ok(r.body?.recipient?.label === 'Mother' && r.body?.recipient?.studentName === 'Ayesha Khan', 'response says it went to the Mother of Ayesha Khan')
  const row = await WhatsappMessage.findOne({ wamid: r.body?.message?.wamid }).lean()
  ok(row && String(row.studentId) === String(ayesha._id), 'stored row is linked to the student')

  r = await call(send, { body: { studentId: String(bilal._id), type: 'text', text: 'Hi' } })
  ok(r.status === 400 && /no WhatsApp number on their record/.test(r.body?.error), 'no number on file → says to add one')
  r = await call(send, { body: { studentId: String(omar._id), type: 'text', text: 'Hi' } })
  ok(r.status === 400 && /isn't in a form WhatsApp can use/.test(r.body?.error), 'unusable number → says to fix it')
  r = await call(send, { body: { studentId: 'not-an-id', type: 'text', text: 'Hi' } })
  ok(r.status === 400 && /Pick a student/.test(r.body?.error), 'malformed student id refused')
  r = await call(send, { body: { studentId: String(new mongoose.Types.ObjectId()), type: 'text', text: 'Hi' } })
  ok(r.status === 400 && /no longer exists/.test(r.body?.error), 'unknown student refused')

  console.log('\nSend to a typed number')
  r = await call(send, { body: { to: '+44 7700 900999', type: 'text', text: 'Assalamu alaikum' } })
  ok(r.status === 201 && calls.at(-1).body?.to === '447700900999' && r.body?.recipient === null, 'international number sent, no recipient label')
  r = await call(send, { body: { to: '0300 1234567', type: 'text', text: 'Hi' } })
  ok(r.status === 400 && /international format/.test(r.body?.error), 'local-format number still refused')

  console.log('\nPlain-English errors from Meta')
  nextError = { code: 131042, message: 'Business eligibility payment issue' }
  r = await call(send, { body: { to: '+447700900999', type: 'text', text: 'Hi' } })
  ok(r.status === 502 && /payment method/.test(r.body?.error) && r.body?.code === 131042, '131042 → add a payment method')
  nextError = { code: 131026, message: 'Message undeliverable' }
  r = await call(send, { body: { to: '+447700900999', type: 'text', text: 'Hi' } })
  ok(/may not be on WhatsApp/.test(r.body?.error), '131026 → may not be on WhatsApp')
  nextError = { code: 132001, message: 'Template name does not exist in the translation' }
  r = await call(send, { body: { to: '+447700900999', type: 'template', templateName: 'nope' } })
  ok(/doesn't exist in this language/.test(r.body?.error), "132001 → template doesn't exist")
  nextError = { code: 999999, message: 'Something odd happened' }
  r = await call(send, { body: { to: '+447700900999', type: 'text', text: 'Hi' } })
  ok(r.body?.error === 'Something odd happened', "an unknown code keeps Meta's own text")
  ok(plainWhatsappError(undefined, '') === 'WhatsApp could not deliver this message.', 'no code and no text → a generic sentence')

  console.log('\nExpired access key')
  nextError = { code: 190, message: 'Error validating access token: Session has expired' }
  r = await call(send, { body: { to: '+447700900999', type: 'text', text: 'Hi' } })
  ok(/test number .*expired/.test(r.body?.error) && /developer/.test(r.body?.error), 'test number: says its key expired and to ask the developer')
  nextError = { code: 190, message: 'Session has expired' }
  r = await call(getTemplates, {})
  ok(r.status === 502 && /test number/.test(r.body?.error) && r.body?.code === 190, 'listing templates says the same')
  ok(/Reconnect the number/.test(plainWhatsappError(190)), 'a connected number is told to reconnect instead')

  console.log('\nFailed messages in the list')
  await WhatsappMessage.create({
    wamid: 'wamid.FAILED_1', direction: 'out', source: 'live', waId: '447700900999', type: 'text', text: 'x',
    status: 'failed', statusErrors: [{ code: 131042, title: 'Business eligibility payment issue' }], timestamp: new Date(),
  })
  r = await call(listMessages, { query: { limit: 50 } })
  const failedRow = r.body?.messages?.find(m => m.wamid === 'wamid.FAILED_1')
  ok(/payment method/.test(failedRow?.failedReason), 'failed message carries a plain failedReason')
  ok(r.body?.stats?.failed === 1, 'stats count the failed message')
  ok(!r.body?.messages?.some(m => m.status !== 'failed' && m.failedReason), 'only failed messages get a reason')
  ok(plainFailure({ statusErrors: [] }) === 'Not delivered', 'a failure with no detail says Not delivered')

  console.log('\nTemplates')
  r = await call(addTemplate, { body: { name: 'fee_notice', category: 'UTILITY', language: 'ur', body: 'Assalamu alaikum' } })
  ok(r.status === 201 && calls.at(-1).body?.language === 'ur', 'an Urdu template is accepted')
  r = await call(addTemplate, { body: { name: 'fee_notice', category: 'UTILITY', language: 'english', body: 'Hi' } })
  ok(r.status === 400 && /language/.test(r.body?.error), 'a made-up language is refused')
} catch (err) {
  fail++
  console.error('Smoke crashed:', err)
} finally {
  if (mongoose.connection.name === SMOKE_DB) await mongoose.connection.dropDatabase().catch(() => {})
  await mongoose.disconnect()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

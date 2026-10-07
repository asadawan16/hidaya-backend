// Smoke test for the WhatsApp Cloud API webhook (/api/whatsapp/webhook).
//
// Covers:
//   - GET verify handshake: right token echoes hub.challenge, wrong token 403
//   - POST signature check: missing / wrong X-Hub-Signature-256 → 401
//   - inbound text is stored, matched to a Student by phone despite formatting
//   - redelivery of the same wamid stores nothing new
//   - inbound media from an unknown number: media id kept, studentId null
//   - outbound status walks forward only (a late 'delivered' can't undo 'read')
//   - 'failed' status records Meta's error details
//
// Mounts the real router on an in-process Express app. Runs against a
// THROWAWAY database (dbName hidaya_whatsapp_smoke) on the same cluster and
// drops it afterwards — production collections are never touched.
// Needs MONGODB_URI only; WHATSAPP_* are set to test values in-process.
// Run: node scripts/smoke-whatsapp-webhook.mjs
import 'dotenv/config'
import crypto from 'crypto'
import express from 'express'
import mongoose from 'mongoose'
import Student from '../models/Student.js'
import WhatsappMessage from '../models/WhatsappMessage.js'
import whatsappWebhookRoutes from '../routes/whatsappWebhookRoutes.js'

process.env.WHATSAPP_VERIFY_TOKEN = 'smoke-verify-token'
process.env.WHATSAPP_APP_SECRET = 'smoke-app-secret'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(100)
  }
  return fn()
}

const sign = (body, secret = process.env.WHATSAPP_APP_SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')

function envelope(value) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_ID', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550000000', phone_number_id: 'PNID_SMOKE' },
      ...value,
    } }] }],
  }
}

const SMOKE_DB = 'hidaya_whatsapp_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
// Hard stop: everything below writes, and the finally block DROPS the database.
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
await WhatsappMessage.init() // unique wamid index must exist before the redelivery test

const app = express()
app.use('/api/whatsapp/webhook', whatsappWebhookRoutes)
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}/api/whatsapp/webhook`

async function post(payload, { signature } = {}) {
  const body = JSON.stringify(payload)
  const headers = { 'Content-Type': 'application/json' }
  const sig = signature === undefined ? sign(body) : signature
  if (sig) headers['X-Hub-Signature-256'] = sig
  return fetch(base, { method: 'POST', headers, body })
}

try {
  console.log('\nVerify handshake')
  let r = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=smoke-verify-token&hub.challenge=12345`)
  ok(r.status === 200 && (await r.text()) === '12345', 'right token → 200 + challenge echoed')
  r = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345`)
  ok(r.status === 403, 'wrong token → 403')

  console.log('\nSignature')
  const student = await Student.create({ name: 'Smoke Student', whatsappNumber: '+92 300 1234567' })
  const textMsg = envelope({
    contacts: [{ wa_id: '923001234567', profile: { name: 'Smoke Parent' } }],
    messages: [{ from: '923001234567', id: 'wamid.SMOKE_IN_1', timestamp: '1760000000', type: 'text', text: { body: 'Assalamu alaikum' } }],
  })
  r = await post(textMsg, { signature: null })
  ok(r.status === 401, 'missing signature → 401')
  r = await post(textMsg, { signature: sign(JSON.stringify(textMsg), 'wrong-secret') })
  ok(r.status === 401, 'wrong secret → 401')
  ok(await WhatsappMessage.countDocuments() === 0, 'nothing stored from rejected posts')

  console.log('\nInbound text')
  r = await post(textMsg)
  ok(r.status === 200, 'signed post → 200')
  const inDoc = await waitFor(() => WhatsappMessage.findOne({ wamid: 'wamid.SMOKE_IN_1' }).lean())
  ok(inDoc?.direction === 'in' && inDoc?.text === 'Assalamu alaikum', 'stored as inbound with its text')
  ok(inDoc?.contactName === 'Smoke Parent' && inDoc?.phoneNumberId === 'PNID_SMOKE', 'contact name + phone number id kept')
  ok(String(inDoc?.studentId) === String(student._id), 'matched to the student despite "+92 300 1234567" formatting')
  ok(inDoc?.timestamp?.getTime() === 1760000000 * 1000, 'timestamp taken from WhatsApp, not arrival')

  r = await post(textMsg)
  await sleep(500)
  ok(await WhatsappMessage.countDocuments({ wamid: 'wamid.SMOKE_IN_1' }) === 1, 'redelivery stores nothing new')

  console.log('\nInbound media, unknown number')
  r = await post(envelope({
    contacts: [{ wa_id: '447700900123', profile: { name: 'Stranger' } }],
    messages: [{ from: '447700900123', id: 'wamid.SMOKE_IN_2', timestamp: '1760000100', type: 'image',
      image: { id: 'MEDIA_1', mime_type: 'image/jpeg', caption: 'homework' } }],
  }))
  const imgDoc = await waitFor(() => WhatsappMessage.findOne({ wamid: 'wamid.SMOKE_IN_2' }).lean())
  ok(imgDoc?.type === 'image' && imgDoc?.media?.id === 'MEDIA_1' && imgDoc?.text === 'homework', 'media id + caption kept')
  ok(imgDoc?.studentId === null, 'unknown number → studentId null')

  console.log('\nOutbound statuses')
  await WhatsappMessage.create({ wamid: 'wamid.SMOKE_OUT_1', direction: 'out', waId: '923001234567', status: 'sent', timestamp: new Date() })
  await post(envelope({ statuses: [{ id: 'wamid.SMOKE_OUT_1', status: 'read', timestamp: '1760000200', recipient_id: '923001234567' }] }))
  let out = await waitFor(async () => {
    const d = await WhatsappMessage.findOne({ wamid: 'wamid.SMOKE_OUT_1' }).lean()
    return d?.status === 'read' ? d : null
  })
  ok(out?.status === 'read', 'sent → read')
  await post(envelope({ statuses: [{ id: 'wamid.SMOKE_OUT_1', status: 'delivered', timestamp: '1760000150', recipient_id: '923001234567' }] }))
  await sleep(500)
  out = await WhatsappMessage.findOne({ wamid: 'wamid.SMOKE_OUT_1' }).lean()
  ok(out?.status === 'read', 'late "delivered" does not regress "read"')

  await WhatsappMessage.create({ wamid: 'wamid.SMOKE_OUT_2', direction: 'out', waId: '923001234567', status: 'sent', timestamp: new Date() })
  await post(envelope({ statuses: [{ id: 'wamid.SMOKE_OUT_2', status: 'failed', timestamp: '1760000300', recipient_id: '923001234567',
    errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'More than 24 hours have passed' } }] }] }))
  const failed = await waitFor(async () => {
    const d = await WhatsappMessage.findOne({ wamid: 'wamid.SMOKE_OUT_2' }).lean()
    return d?.status === 'failed' ? d : null
  })
  ok(failed?.statusErrors?.[0]?.code === 131047 && /24 hours/.test(failed?.statusErrors?.[0]?.details), 'failed status keeps Meta error code + details')

  await post(envelope({ statuses: [{ id: 'wamid.NEVER_SENT', status: 'delivered', timestamp: '1760000400' }] }))
  await sleep(500)
  ok(await WhatsappMessage.countDocuments({ wamid: 'wamid.NEVER_SENT' }) === 0, 'status for an unknown message creates nothing')
} finally {
  server.close()
  if (mongoose.connection.name === SMOKE_DB) await mongoose.connection.dropDatabase().catch(async () => {
    await WhatsappMessage.deleteMany({})
    await Student.deleteMany({ name: 'Smoke Student' })
  })
  await mongoose.disconnect()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

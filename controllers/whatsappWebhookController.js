import crypto from 'crypto'
import WhatsappMessage from '../models/WhatsappMessage.js'
import Student from '../models/Student.js'
import { emitToRole } from '../config/socket.js'

/*
 * WhatsApp Cloud API webhook — GET /api/whatsapp/webhook (Meta's one-off
 * verification handshake) and POST /api/whatsapp/webhook (every incoming
 * message and every status update on a message we sent).
 *
 * The POST is mounted in index.js with express.raw() BEFORE express.json(),
 * because X-Hub-Signature-256 is an HMAC over the exact bytes Meta sent — a
 * re-serialized body never verifies. Server-to-server, so it sits outside
 * CORS/auth and is authenticated by that signature alone.
 *
 * Env:
 *   WHATSAPP_VERIFY_TOKEN  the string typed into the Meta dashboard's
 *                          "Verify token" box (we choose it, Meta echoes it)
 *   WHATSAPP_APP_SECRET    App settings → Basic → App secret (signs the POSTs)
 *
 * Meta delivers at-least-once and retries anything that isn't a fast 200, so
 * we acknowledge first and process after. Idempotency comes from the unique
 * `wamid` on WhatsappMessage: a redelivered message loses the insert race.
 */

// ── GET: verification handshake ─────────────────────────────────────────────
export function verifyWhatsappWebhook(req, res) {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  const expected = process.env.WHATSAPP_VERIFY_TOKEN

  if (mode === 'subscribe' && expected && typeof token === 'string' && safeEqual(token, expected)) {
    // Meta wants the challenge echoed back as the bare body, nothing else
    return res.status(200).type('text/plain').send(String(challenge ?? ''))
  }
  return res.sendStatus(403)
}

// ── POST: messages + statuses ───────────────────────────────────────────────
export async function whatsappWebhook(req, res) {
  const secret = process.env.WHATSAPP_APP_SECRET
  if (!secret) {
    console.error('WhatsApp webhook: WHATSAPP_APP_SECRET is not set — rejecting')
    return res.sendStatus(500)
  }
  if (!Buffer.isBuffer(req.body) || !isValidSignature(req.body, req.headers['x-hub-signature-256'], secret)) {
    console.error('WhatsApp webhook signature verification failed')
    return res.sendStatus(401)
  }

  let payload
  try {
    payload = JSON.parse(req.body.toString('utf8'))
  } catch {
    return res.sendStatus(400)
  }

  res.sendStatus(200)

  try {
    await processWebhookPayload(payload)
  } catch (err) {
    console.error('WhatsApp webhook handler error:', err)
  }
}

export function isValidSignature(rawBody, header, secret) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  return safeEqual(header, expected)
}

function safeEqual(a, b) {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

/*
 * Walk a webhook body. Exported so smoke tests can drive it without HTTP.
 * Shape: { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value }] }] }
 */
export async function processWebhookPayload(payload) {
  if (payload?.object !== 'whatsapp_business_account') return
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages' || !change.value) continue
      const value = change.value
      const phoneNumberId = value.metadata?.phone_number_id || ''
      const names = new Map((value.contacts || []).map(c => [c.wa_id, c.profile?.name || '']))

      for (const msg of value.messages || []) {
        await recordInbound(msg, { phoneNumberId, contactName: names.get(msg.from) || '' })
      }
      for (const st of value.statuses || []) {
        await applyStatus(st)
      }
    }
  }
}

// ── Inbound ─────────────────────────────────────────────────────────────────
async function recordInbound(msg, { phoneNumberId, contactName }) {
  if (!msg?.id || !msg.from) return
  const { text, media } = describeMessage(msg)
  const studentId = await findStudentIdByPhone(msg.from)

  const doc = {
    wamid: msg.id,
    direction: 'in',
    waId: msg.from,
    contactName,
    phoneNumberId,
    type: msg.type || 'unsupported',
    text,
    contextWamid: msg.context?.id || msg.reaction?.message_id || '',
    status: 'received',
    timestamp: toDate(msg.timestamp),
    studentId,
  }
  if (media) doc.media = media

  let saved
  try {
    saved = await WhatsappMessage.create(doc)
  } catch (err) {
    if (err?.code === 11000) return // redelivery — already stored
    throw err
  }

  const event = {
    _id: saved._id,
    wamid: saved.wamid,
    waId: saved.waId,
    contactName: saved.contactName,
    type: saved.type,
    text: saved.text,
    timestamp: saved.timestamp,
    studentId: saved.studentId,
  }
  for (const role of NOTIFY_ROLES) emitToRole(role, 'whatsapp_message', event)
}

// Staff who see WhatsApp traffic live until a dedicated permission exists
const NOTIFY_ROLES = ['super_admin', 'admin']

function describeMessage(msg) {
  switch (msg.type) {
    case 'text':
      return { text: msg.text?.body || '' }
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker': {
      const m = msg[msg.type] || {}
      return {
        text: m.caption || '',
        media: { id: m.id, mimeType: m.mime_type, filename: m.filename },
      }
    }
    case 'interactive':
      return { text: msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '' }
    case 'button':
      // Quick-reply tap on a template we sent
      return { text: msg.button?.text || '' }
    case 'reaction':
      return { text: msg.reaction?.emoji || '' }
    case 'location': {
      const l = msg.location || {}
      return { text: [l.name, l.address].filter(Boolean).join(', ') || `${l.latitude}, ${l.longitude}` }
    }
    case 'contacts':
      return { text: (msg.contacts || []).map(c => c.name?.formatted_name).filter(Boolean).join(', ') }
    default:
      return { text: '' }
  }
}

/*
 * Phones are stored however staff typed them — "+92 300 1234567",
 * "0300-1234567", "923001234567". Match on the last 10 digits with anything
 * non-numeric allowed between them, across the student's WhatsApp number,
 * legacy phone and guardian phones. Returns the first match or null.
 */
export async function findStudentIdByPhone(waId) {
  const digits = String(waId || '').replace(/\D/g, '')
  if (digits.length < 7) return null
  const tail = digits.slice(-10)
  const re = new RegExp(tail.split('').join('\\D*') + '\\D*$')
  const student = await Student.findOne({
    $or: [{ whatsappNumber: re }, { phone: re }, { 'guardians.phone': re }],
  }).select('_id').lean()
  return student?._id || null
}

// ── Status updates on messages we sent ──────────────────────────────────────
// A status only ever moves forward. Meta can deliver 'delivered' after 'read';
// the filter below makes the stale one a no-op instead of a regression.
const STATUS_RANK = { accepted: 0, sent: 1, delivered: 2, read: 3, failed: 4 }

async function applyStatus(st) {
  if (!st?.id || !(st.status in STATUS_RANK)) return
  const rank = STATUS_RANK[st.status]
  const lower = Object.keys(STATUS_RANK).filter(s => STATUS_RANK[s] < rank)

  const update = { status: st.status, statusAt: toDate(st.timestamp) }
  if (st.status === 'failed') {
    update.statusErrors = (st.errors || []).map(e => ({
      code: e.code,
      title: e.title || e.message || '',
      details: e.error_data?.details || '',
    }))
  }

  // No upsert: a status for a message we never recorded (e.g. sent from the
  // Meta dashboard's test console) has nothing to attach to.
  const updated = await WhatsappMessage.findOneAndUpdate(
    { wamid: st.id, direction: 'out', status: { $in: lower } },
    { $set: update },
    { new: true, projection: { wamid: 1, waId: 1, status: 1, statusAt: 1 } },
  ).lean()

  if (updated) {
    for (const role of NOTIFY_ROLES) emitToRole(role, 'whatsapp_status', updated)
  }
}

function toDate(unixSeconds) {
  const n = Number(unixSeconds)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date()
}

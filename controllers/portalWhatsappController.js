import WhatsappConnection from '../models/WhatsappConnection.js'
import WhatsappMessage from '../models/WhatsappMessage.js'
import WhatsappChat from '../models/WhatsappChat.js'
import { emitToRole } from '../config/socket.js'
import { findStudentIdByPhone } from './whatsappWebhookController.js'
import { encryptSecret, decryptSecret } from '../utils/totp.js'
import { logActivity } from '../utils/activityLogger.js'
import Student from '../models/Student.js'
import { toWaId, resolveStudentRecipient } from '../utils/waNumber.js'
import { plainWhatsappError, plainFailure } from '../utils/whatsappErrors.js'
import { touchChat, syncChat, announceChat } from '../utils/whatsappChats.js'
import {
  META_APP_ID, WHATSAPP_ES_CONFIG_ID, GRAPH_VERSION, GraphError,
  exchangeCodeForToken, inspectToken, listPhoneNumbers, getPhoneNumber, subscribeApp, unsubscribeApp, requestAppSync,
  sendMessage, listTemplates, createTemplate, getAppSubscription, setAppSubscription,
} from '../services/whatsappGraph.js'
import WhatsappContact from '../models/WhatsappContact.js'
import { phoneKey, nameOf } from '../utils/whatsappContacts.js'

/*
 * /api/portal/whatsapp — connect the academy's WhatsApp Business number via
 * Meta's Embedded Signup (whatsapp.manage, super-admin only by default).
 *
 * The browser runs FB.login on /portal/whatsapp and posts back the one-time
 * `code` plus the WABA / phone number ids Meta reported. We exchange the code
 * for a business token, confirm the number belongs to that WABA, subscribe our
 * app to its webhooks and — for a coexistence number still on the phone app —
 * ask Meta to replay the phone's contacts and chat history.
 */

const IDS = /^\d{5,25}$/

function publicView(conn) {
  if (!conn) return null
  const { accessTokenEnc, __v, ...rest } = conn
  return rest
}

async function loadConnection() {
  return WhatsappConnection.findOne({ key: 'default' }).populate('connectedBy', 'displayName email').lean()
}

export async function getConnection(_req, res) {
  try {
    res.json({
      appId: META_APP_ID,
      configId: WHATSAPP_ES_CONFIG_ID,
      graphVersion: GRAPH_VERSION,
      serverReady: Boolean(process.env.WHATSAPP_APP_SECRET && process.env.MFA_ENCRYPTION_KEY),
      connection: publicView(await loadConnection()),
      sender: describeSender(await resolveSender()),
    })
  } catch (err) {
    console.error('Get WhatsApp connection error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/*
 * The whole onboarding, minus HTTP. Exported for scripts/smoke-whatsapp-connect.mjs,
 * which stubs global fetch in place of Meta.
 */
export async function connectWhatsappNumber({ code, wabaId, phoneNumberId, businessId, coexistence, userId }) {
  const token = await exchangeCodeForToken(code)
  const number = pickNumber(await listPhoneNumbers(wabaId, token), phoneNumberId)
  return saveConnection({ token, wabaId, number, businessId, coexistence, userId, connectMethod: 'embedded_signup' })
}

function pickNumber(numbers, phoneNumberId) {
  if (phoneNumberId) {
    const number = numbers.find(n => n.id === phoneNumberId)
    if (!number) throw new GraphError('That phone number is not on the WhatsApp Business Account Meta returned')
    return number
  }
  if (numbers.length === 1) return numbers[0]
  throw new GraphError(numbers.length ? 'Meta returned several numbers and did not say which one was connected' : 'No phone number found on that WhatsApp Business Account')
}

const NEEDED_SCOPES = ['whatsapp_business_management', 'whatsapp_business_messaging']

/*
 * Connect with an access key instead of the Facebook window. For the academy's
 * own number: its business portfolio owns HidayaOnlineApp, and Embedded Signup
 * can't share a WhatsApp account with the business that owns the app (Meta:
 * "isn't a valid Business ID", #1690130). The key is a system-user token from
 * that portfolio, generated for this app with the two WhatsApp permissions;
 * after the checks it is used exactly like the token Embedded Signup returns.
 * Returns { connection, warnings }.
 */
export async function connectWithAccessKey({ accessToken, wabaId, phoneNumberId, userId }) {
  const info = await inspectToken(accessToken)
  if (!info.isValid) throw new GraphError("Meta says that access key isn't valid. It may have been copied with a piece missing, or revoked. Generate a new one and paste it again.")
  if (info.appId && info.appId !== META_APP_ID) throw new GraphError('That access key was made for a different Meta app. Generate it for HidayaOnlineApp.')
  const missing = NEEDED_SCOPES.filter(s => !info.scopes.includes(s))
  if (missing.length) throw new GraphError(`That access key is missing the permission${missing.length > 1 ? 's' : ''} ${missing.join(' and ')}. Tick ${missing.length > 1 ? 'them' : 'it'} when generating the key.`)

  const numbers = await listPhoneNumbers(wabaId, accessToken)
  if (!numbers.length) throw new GraphError('That WhatsApp Business Account has no phone number yet. Check in WhatsApp Manager that the number is linked to it.')
  if (!phoneNumberId && numbers.length > 1) {
    const list = numbers.map(n => `${n.display_phone_number || 'unnamed'} (ID ${n.id})`).join(', ')
    throw new GraphError(`That account has ${numbers.length} numbers: ${list}. Paste the phone number ID of the one to connect.`)
  }
  let number = pickNumber(numbers, phoneNumberId)

  // The fuller record says whether the number is still on the office phone
  try { number = { ...number, ...(await getPhoneNumber(number.id, accessToken)) } } catch { /* the list entry is enough */ }
  const warnings = []
  if (number.platform_type && number.platform_type !== 'CLOUD_API') {
    warnings.push(`Meta says this number isn't switched on for sending from the portal yet (${number.platform_type}). Messages may fail until it is.`)
  }
  if (info.expiresAt) {
    warnings.push(`This access key stops working on ${new Date(info.expiresAt * 1000).toUTCString()}. Generate one that never expires so WhatsApp doesn't stop then.`)
  }

  const connection = await saveConnection({
    token: accessToken, wabaId, number, businessId: '', userId, connectMethod: 'manual',
    // Unknown counts as yes: the academy's number lives on the office phone, and
    // a sync request for a number that isn't there is refused and stored, not thrown
    coexistence: number.is_on_biz_app !== false,
  })
  return { connection, warnings }
}

async function saveConnection({ token, wabaId, number, businessId, coexistence, userId, connectMethod }) {
  await subscribeApp(wabaId, token)
  const now = new Date()

  const update = {
    status: 'connected',
    wabaId,
    businessId: businessId || '',
    phoneNumberId: number.id,
    displayPhoneNumber: number.display_phone_number || '',
    verifiedName: number.verified_name || '',
    qualityRating: number.quality_rating || '',
    coexistence: Boolean(coexistence),
    connectMethod,
    accessTokenEnc: encryptSecret(token),
    subscribedAt: now,
    connectedBy: userId || null,
    connectedAt: now,
    contactsSync: {},
    historySync: {},
    historyProgress: null,
    historyDeclined: false,
  }
  if (coexistence) Object.assign(update, await runAppSyncs(number.id, token))

  await WhatsappConnection.findOneAndUpdate(
    { key: 'default' }, { $set: update, $unset: { disconnectedAt: 1 } }, { upsert: true },
  )
  return loadConnection()
}

// Contacts first, then history — Meta's documented order. A failure is stored, not thrown.
async function runAppSyncs(phoneNumberId, token) {
  const out = {}
  for (const [field, type] of [['contactsSync', 'smb_app_state_sync'], ['historySync', 'history']]) {
    try {
      await requestAppSync(phoneNumberId, token, type)
      out[field] = { requestedAt: new Date(), error: '' }
    } catch (err) {
      out[field] = { requestedAt: new Date(), error: err.message }
    }
  }
  return out
}

export async function connect(req, res) {
  const { code, wabaId, phoneNumberId, businessId, coexistence } = req.body || {}
  if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ error: 'Missing signup code from Meta' })
  if (!IDS.test(String(wabaId || ''))) return res.status(400).json({ error: 'Missing or invalid WhatsApp Business Account id' })
  if (phoneNumberId && !IDS.test(String(phoneNumberId))) return res.status(400).json({ error: 'Invalid phone number id' })
  if (businessId && !IDS.test(String(businessId))) return res.status(400).json({ error: 'Invalid business id' })
  if (!process.env.WHATSAPP_APP_SECRET || !process.env.MFA_ENCRYPTION_KEY) {
    return res.status(503).json({ error: 'Server is missing WHATSAPP_APP_SECRET or MFA_ENCRYPTION_KEY' })
  }

  try {
    const connection = await connectWhatsappNumber({
      code: code.trim(), wabaId: String(wabaId), phoneNumberId: phoneNumberId ? String(phoneNumberId) : '',
      businessId: businessId ? String(businessId) : '', coexistence: coexistence !== false, userId: req.userId,
    })
    await logActivity({
      level: 'info', category: 'portal', action: 'whatsapp_connected',
      message: `WhatsApp number ${connection.displayPhoneNumber || connection.phoneNumberId} connected${connection.coexistence ? ' (coexistence)' : ''}`, req,
    })
    res.json({ connection: publicView(connection) })
  } catch (err) {
    if (err instanceof GraphError) return res.status(502).json({ error: err.message })
    console.error('Connect WhatsApp error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function connectManual(req, res) {
  const { accessToken, wabaId, phoneNumberId } = req.body || {}
  const token = typeof accessToken === 'string' ? accessToken.trim() : ''
  if (!/^[A-Za-z0-9_|-]{20,2000}$/.test(token)) return res.status(400).json({ error: "That doesn't look like an access key. Copy the whole key Meta showed you and paste it again." })
  if (!IDS.test(String(wabaId || '').trim())) return res.status(400).json({ error: 'Enter the WhatsApp Business Account ID (digits only)' })
  if (phoneNumberId && !IDS.test(String(phoneNumberId).trim())) return res.status(400).json({ error: 'The phone number ID should be digits only' })
  if (!process.env.WHATSAPP_APP_SECRET || !process.env.MFA_ENCRYPTION_KEY) {
    return res.status(503).json({ error: 'Server is missing WHATSAPP_APP_SECRET or MFA_ENCRYPTION_KEY' })
  }

  try {
    const { connection, warnings } = await connectWithAccessKey({
      accessToken: token, wabaId: String(wabaId).trim(),
      phoneNumberId: phoneNumberId ? String(phoneNumberId).trim() : '', userId: req.userId,
    })
    await logActivity({
      level: 'info', category: 'portal', action: 'whatsapp_connected',
      message: `WhatsApp number ${connection.displayPhoneNumber || connection.phoneNumberId} connected with an access key${connection.coexistence ? ' (coexistence)' : ''}`, req,
    })
    res.json({ connection: publicView(connection), warnings })
  } catch (err) {
    if (err instanceof GraphError) return res.status(502).json({ error: err.message })
    console.error('Connect WhatsApp (access key) error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Retry the contacts + history replay (e.g. the first request failed). Meta refuses after 24h.
export async function resync(req, res) {
  try {
    const conn = await WhatsappConnection.findOne({ key: 'default', status: 'connected' }).select('+accessTokenEnc').lean()
    if (!conn) return res.status(404).json({ error: 'No WhatsApp number is connected' })
    if (!conn.coexistence) return res.status(400).json({ error: 'History sync only applies to a number that is still on the WhatsApp Business app' })

    const update = await runAppSyncs(conn.phoneNumberId, decryptSecret(conn.accessTokenEnc))
    await WhatsappConnection.updateOne({ _id: conn._id }, { $set: update })
    res.json({ connection: publicView(await loadConnection()) })
  } catch (err) {
    console.error('WhatsApp resync error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/*
 * Stops this server receiving the number's webhooks and forgets the token.
 * The number itself stays on Meta (and on the phone) — remove it in WhatsApp
 * Manager if that is what's wanted.
 *
 * Opt-in (?deleteChats=1): also delete every message that went through this
 * number, so a number being replaced leaves no stale conversations in
 * WhatsApp Chats. Only this number's messages go (each one records the
 * business number it used); a contact who also wrote to another number keeps
 * those messages and their chat. Nothing on Meta or the phone is touched.
 */
export async function disconnect(req, res) {
  const deleteChats = req.query?.deleteChats === '1' || req.body?.deleteChats === true
  try {
    const conn = await WhatsappConnection.findOne({ key: 'default', status: 'connected' }).select('+accessTokenEnc').lean()
    if (!conn) return res.status(404).json({ error: 'No WhatsApp number is connected' })

    let warning = ''
    try {
      await unsubscribeApp(conn.wabaId, decryptSecret(conn.accessTokenEnc))
    } catch (err) {
      warning = `Meta did not confirm the webhook unsubscribe: ${err.message}`
    }
    await WhatsappConnection.updateOne({ _id: conn._id }, {
      $set: { status: 'disconnected', accessTokenEnc: '', disconnectedAt: new Date() },
    })

    let deleted = null
    if (deleteChats) {
      try {
        deleted = await deleteNumberMessages(conn.phoneNumberId)
      } catch (err) {
        console.error('Delete WhatsApp chats on disconnect error:', err)
        warning = [warning, "The number was disconnected, but its chats couldn't be deleted. Try again later."].filter(Boolean).join(' ')
      }
    }
    await logActivity({
      level: 'info', category: 'portal', action: 'whatsapp_disconnected',
      message: `WhatsApp number ${conn.displayPhoneNumber || conn.phoneNumberId} disconnected${deleted ? ` and ${deleted.messages} messages deleted from the portal` : ''}`, req,
    })
    res.json({ connection: publicView(await loadConnection()), warning, deleted })
  } catch (err) {
    console.error('Disconnect WhatsApp error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/*
 * Every message that went through one of our business numbers, gone, and the
 * chat list recomputed for the contacts involved: a chat with nothing left is
 * dropped, one that also has another number's messages stays. Exported for
 * scripts/smoke-whatsapp-connect.mjs.
 */
export async function deleteNumberMessages(phoneNumberId) {
  if (!phoneNumberId) return { messages: 0, chats: 0 }
  const waIds = await WhatsappMessage.distinct('waId', { phoneNumberId })
  const chatIds = await WhatsappChat.find({ waId: { $in: waIds } }).distinct('_id')
  const { deletedCount } = await WhatsappMessage.deleteMany({ phoneNumberId })
  let chats = 0
  for (const waId of waIds) {
    // Gone from the list: no row left, or a removed-from-portal row with nothing after its cut-off
    if (!(await syncChat(waId))?.lastMessageAt) chats++
  }
  // Open WhatsApp Chats pages refetch their list
  for (const id of chatIds) announceChat(id)
  return { messages: deletedCount, chats }
}

// ── Sending + templates ─────────────────────────────────────────────────────
/*
 * Who sends: the number connected through Embedded Signup when there is one,
 * otherwise Meta's free test number from WhatsApp → API Setup, configured with
 * WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_WABA_ID. The test
 * number is what the App Review screencasts are recorded with, before the real
 * number can be connected.
 */
export async function resolveSender() {
  const conn = await WhatsappConnection.findOne({ key: 'default', status: 'connected' }).select('+accessTokenEnc').lean()
  if (conn?.accessTokenEnc) {
    return {
      source: 'connected', token: decryptSecret(conn.accessTokenEnc), phoneNumberId: conn.phoneNumberId,
      wabaId: conn.wabaId, displayPhoneNumber: conn.displayPhoneNumber,
    }
  }
  const { WHATSAPP_ACCESS_TOKEN: token, WHATSAPP_PHONE_NUMBER_ID: phoneNumberId, WHATSAPP_WABA_ID: wabaId } = process.env
  if (token && phoneNumberId && wabaId) return { source: 'test', token, phoneNumberId, wabaId, displayPhoneNumber: '' }
  return null
}

// Meta's error in plain words. An expired token means something different for
// the API Setup test number (its token lives in the server's settings and
// lasts a day) than for the connected number (reconnect it on the page).
const TEST_TOKEN_EXPIRED = "Meta's test number has stopped working because its access key expired (they last 24 hours). Ask your developer for a new one, or connect the academy's own number."
export function senderError(err, sender) {
  if (Number(err.code) === 190 && sender?.source === 'test') return TEST_TOKEN_EXPIRED
  return plainWhatsappError(err.code, err.message)
}

function describeSender(sender) {
  if (!sender) return { source: 'none' }
  const { token, ...rest } = sender
  return rest
}

export async function listMessages(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100)
    // Chats removed from the portal: their messages up to the cut-off stay hidden here too
    const cleared = await WhatsappChat.find({ clearedAt: { $ne: null } }).select('waId clearedAt').lean()
    const visible = cleared.length ? { $nor: cleared.map(c => ({ waId: c.waId, timestamp: { $lte: c.clearedAt } })) } : {}
    const [messages, sent, received, read, failed] = await Promise.all([
      WhatsappMessage.find(visible)
        .sort({ timestamp: -1 }).limit(limit)
        .select('wamid direction source waId contactName type text templateName status statusErrors timestamp sentBy studentId')
        .populate('sentBy', 'displayName email').populate('studentId', 'name')
        .lean(),
      WhatsappMessage.countDocuments({ direction: 'out' }),
      WhatsappMessage.countDocuments({ direction: 'in' }),
      WhatsappMessage.countDocuments({ direction: 'out', status: 'read' }),
      WhatsappMessage.countDocuments({ direction: 'out', status: 'failed' }),
    ])
    for (const m of messages) if (m.status === 'failed') m.failedReason = plainFailure(m)
    // The name each number is saved under (contact book), for the conversation chips
    const keys = [...new Set(messages.map(m => phoneKey(m.waId)).filter(Boolean))]
    const book = new Map((keys.length ? await WhatsappContact.find({ key: { $in: keys } }).lean() : []).map(c => [c.key, nameOf(c).name]))
    for (const m of messages) m.savedName = book.get(phoneKey(m.waId)) || ''
    res.json({ messages, stats: { sent, received, read, failed } })
  } catch (err) {
    console.error('List WhatsApp messages error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Who a student's message goes to: the same order class reminders use
async function studentRecipient(studentId) {
  if (!/^[a-f\d]{24}$/i.test(String(studentId))) return { error: 'Pick a student' }
  const student = await Student.findById(studentId).select('name country guardians whatsappNumber phone').lean()
  if (!student) return { error: 'That student no longer exists' }
  const { recipient, reason } = resolveStudentRecipient(student)
  if (!recipient) {
    return { error: reason === 'invalid'
      ? `The number on ${student.name}'s record isn't in a form WhatsApp can use. Fix it on the student's page.`
      : `${student.name} has no WhatsApp number on their record yet. Add one on the student's page.` }
  }
  return { waId: recipient.waId, label: recipient.label, student }
}

export async function send(req, res) {
  const { to, studentId, type = 'text', text, templateName, language = 'en_US', params } = req.body || {}
  let waId = ''
  let recipient = null
  if (studentId) {
    const found = await studentRecipient(studentId)
    if (found.error) return res.status(400).json({ error: found.error })
    waId = found.waId
    recipient = { label: found.label, studentName: found.student.name }
  } else {
    waId = toWaId(to)
    if (!waId) return res.status(400).json({ error: 'Enter the number in international format, e.g. +92 300 1234567' })
  }
  if (!['text', 'template'].includes(type)) return res.status(400).json({ error: 'Unknown message type' })
  if (type === 'text' && (typeof text !== 'string' || !text.trim())) return res.status(400).json({ error: 'Message text is required' })
  if (type === 'template' && (typeof templateName !== 'string' || !/^[a-z0-9_]+$/.test(templateName))) {
    return res.status(400).json({ error: 'Pick a template' })
  }

  let sender = null
  try {
    sender = await resolveSender()
    if (!sender) return res.status(503).json({ error: 'No WhatsApp number is connected and no test number is configured' })

    const values = Array.isArray(params) ? params.map(v => String(v ?? '').trim()).filter(Boolean) : []
    const payload = type === 'text'
      ? { to: waId, type: 'text', text: { body: text.trim(), preview_url: false } }
      : {
          to: waId, type: 'template',
          template: {
            name: templateName, language: { code: String(language) },
            ...(values.length ? { components: [{ type: 'body', parameters: values.map(v => ({ type: 'text', text: v })) }] } : {}),
          },
        }
    const wamid = await sendMessage(sender.phoneNumberId, sender.token, payload)

    const saved = await WhatsappMessage.create({
      wamid, direction: 'out', source: 'live', waId, phoneNumberId: sender.phoneNumberId,
      type, text: type === 'text' ? text.trim() : values.join(' · '), templateName: type === 'template' ? templateName : '',
      status: 'accepted', timestamp: new Date(), sentBy: req.userId, studentId: recipient ? studentId : await findStudentIdByPhone(waId),
    })
    const event = { _id: saved._id, wamid, direction: 'out', source: 'live', waId, type, text: saved.text, timestamp: saved.timestamp }
    for (const role of ['super_admin', 'admin']) emitToRole(role, 'whatsapp_message', event)
    await touchChat(waId)
    await logActivity({ level: 'info', category: 'portal', action: 'whatsapp_sent', message: `WhatsApp ${type} sent to ${waId}`, req })
    res.status(201).json({ message: saved, recipient })
  } catch (err) {
    if (err instanceof GraphError) return res.status(502).json({ error: senderError(err, sender), code: err.code })
    console.error('Send WhatsApp error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getTemplates(_req, res) {
  let sender = null
  try {
    sender = await resolveSender()
    if (!sender) return res.json({ templates: [] })
    res.json({ templates: await listTemplates(sender.wabaId, sender.token) })
  } catch (err) {
    if (err instanceof GraphError) return res.status(502).json({ error: senderError(err, sender), code: err.code })
    console.error('List WhatsApp templates error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING']

export async function addTemplate(req, res) {
  const { name, category = 'UTILITY', language = 'en_US', body, examples } = req.body || {}
  if (typeof name !== 'string' || !/^[a-z0-9_]{1,512}$/.test(name)) {
    return res.status(400).json({ error: 'Template name: lowercase letters, numbers and underscores only' })
  }
  if (!TEMPLATE_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Category must be Utility or Marketing' })
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(String(language))) return res.status(400).json({ error: 'Unknown template language' })
  if (typeof body !== 'string' || !body.trim() || body.length > 1024) {
    return res.status(400).json({ error: 'Message body is required (max 1024 characters)' })
  }

  // {{1}}, {{2}}… need one example value each, or Meta rejects the template
  const vars = [...new Set(body.match(/\{\{\d+\}\}/g) || [])]
  const ex = Array.isArray(examples) ? examples.map(v => String(v ?? '').trim()) : []
  if (vars.length && ex.slice(0, vars.length).filter(Boolean).length < vars.length) {
    return res.status(400).json({ error: `Give an example value for each of the ${vars.length} variable(s)` })
  }

  let sender = null
  try {
    sender = await resolveSender()
    if (!sender) return res.status(503).json({ error: 'No WhatsApp number is connected and no test number is configured' })
    const component = { type: 'BODY', text: body.trim() }
    if (vars.length) component.example = { body_text: [ex.slice(0, vars.length)] }
    const created = await createTemplate(sender.wabaId, sender.token, {
      name, category, language: String(language), components: [component],
    })
    await logActivity({ level: 'info', category: 'portal', action: 'whatsapp_template_created', message: `WhatsApp template ${name} submitted`, req })
    res.status(201).json({ template: { id: created.id, name, category: created.category || category, status: created.status || 'PENDING', language } })
  } catch (err) {
    if (err instanceof GraphError) return res.status(502).json({ error: senderError(err, sender), code: err.code })
    console.error('Create WhatsApp template error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/*
 * Which webhook fields the Meta app sends us. Without smb_message_echoes,
 * history and smb_app_state_sync, a number shared with the office phone still
 * receives messages, but nothing typed on the phone, none of its past chats and
 * none of its saved contact names ever reach the portal. GET reports what is
 * on; POST turns on what is missing (keeping everything already on).
 */
export const PHONE_FIELDS = [
  { field: 'messages', label: 'Messages from families' },
  { field: 'smb_message_echoes', label: 'Messages typed on the office phone' },
  { field: 'smb_app_state_sync', label: "The phone's saved contact names" },
  { field: 'history', label: "The phone's past chats" },
]

function describeFields(sub) {
  const on = new Set(sub?.fields || [])
  return {
    configured: Boolean(sub?.callbackUrl),
    active: Boolean(sub?.active),
    callbackUrl: sub?.callbackUrl || '',
    fields: PHONE_FIELDS.map(f => ({ ...f, on: on.has(f.field) })),
    missing: PHONE_FIELDS.filter(f => !on.has(f.field)).map(f => f.field),
  }
}

export async function getWebhookFields(_req, res) {
  try {
    res.json(describeFields(await getAppSubscription()))
  } catch (err) {
    if (err instanceof GraphError) return res.status(502).json({ error: `Couldn't ask Meta: ${err.message}` })
    console.error('WhatsApp webhook fields error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function enableWebhookFields(req, res) {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN
  if (!verifyToken) return res.status(503).json({ error: 'The server has no WHATSAPP_VERIFY_TOKEN, so Meta cannot confirm the webhook' })
  try {
    const sub = await getAppSubscription()
    if (!sub?.callbackUrl) {
      return res.status(409).json({ error: "The Meta app has no webhook address yet. Set it up once in the Meta app's WhatsApp → Configuration page, then try again." })
    }
    const fields = [...new Set([...(sub.fields || []), ...PHONE_FIELDS.map(f => f.field)])]
    await setAppSubscription({ callbackUrl: sub.callbackUrl, verifyToken, fields })
    const fresh = describeFields(await getAppSubscription())
    await logActivity({
      level: 'info', category: 'portal', action: 'whatsapp_webhook_fields',
      message: `WhatsApp webhook fields turned on: ${PHONE_FIELDS.map(f => f.field).join(', ')}`, req,
    })
    res.json(fresh)
  } catch (err) {
    if (err instanceof GraphError) return res.status(502).json({ error: `Meta refused: ${err.message}` })
    console.error('Enable WhatsApp webhook fields error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

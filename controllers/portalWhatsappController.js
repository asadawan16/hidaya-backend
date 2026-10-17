import WhatsappConnection from '../models/WhatsappConnection.js'
import WhatsappMessage from '../models/WhatsappMessage.js'
import { emitToRole } from '../config/socket.js'
import { findStudentIdByPhone } from './whatsappWebhookController.js'
import { encryptSecret, decryptSecret } from '../utils/totp.js'
import { logActivity } from '../utils/activityLogger.js'
import {
  META_APP_ID, WHATSAPP_ES_CONFIG_ID, GRAPH_VERSION, GraphError,
  exchangeCodeForToken, listPhoneNumbers, subscribeApp, unsubscribeApp, requestAppSync,
  sendMessage, listTemplates, createTemplate,
} from '../services/whatsappGraph.js'

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

  const numbers = await listPhoneNumbers(wabaId, token)
  let number
  if (phoneNumberId) {
    number = numbers.find(n => n.id === phoneNumberId)
    if (!number) throw new GraphError('That phone number is not on the WhatsApp Business Account Meta returned')
  } else if (numbers.length === 1) {
    number = numbers[0]
  } else {
    throw new GraphError(numbers.length ? 'Meta returned several numbers and did not say which one was connected' : 'No phone number found on that WhatsApp Business Account')
  }

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
 */
export async function disconnect(req, res) {
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
    await logActivity({
      level: 'info', category: 'portal', action: 'whatsapp_disconnected',
      message: `WhatsApp number ${conn.displayPhoneNumber || conn.phoneNumberId} disconnected`, req,
    })
    res.json({ connection: publicView(await loadConnection()), warning })
  } catch (err) {
    console.error('Disconnect WhatsApp error:', err)
    res.status(500).json({ error: 'Server error' })
  }
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

function describeSender(sender) {
  if (!sender) return { source: 'none' }
  const { token, ...rest } = sender
  return rest
}

// International digits only: "+92 300-1234567" / "0092…" → "923001234567"
function toWaId(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  return d.length >= 8 && d.length <= 15 && !d.startsWith('0') ? d : ''
}

export async function listMessages(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100)
    const [messages, sent, received, read] = await Promise.all([
      WhatsappMessage.find({})
        .sort({ timestamp: -1 }).limit(limit)
        .select('wamid direction source waId contactName type text templateName status statusErrors timestamp sentBy studentId')
        .populate('sentBy', 'displayName email').populate('studentId', 'name')
        .lean(),
      WhatsappMessage.countDocuments({ direction: 'out' }),
      WhatsappMessage.countDocuments({ direction: 'in' }),
      WhatsappMessage.countDocuments({ direction: 'out', status: 'read' }),
    ])
    res.json({ messages, stats: { sent, received, read } })
  } catch (err) {
    console.error('List WhatsApp messages error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function send(req, res) {
  const { to, type = 'text', text, templateName, language = 'en_US', params } = req.body || {}
  const waId = toWaId(to)
  if (!waId) return res.status(400).json({ error: 'Enter the number in international format, e.g. +92 300 1234567' })
  if (!['text', 'template'].includes(type)) return res.status(400).json({ error: 'Unknown message type' })
  if (type === 'text' && (typeof text !== 'string' || !text.trim())) return res.status(400).json({ error: 'Message text is required' })
  if (type === 'template' && (typeof templateName !== 'string' || !/^[a-z0-9_]+$/.test(templateName))) {
    return res.status(400).json({ error: 'Pick a template' })
  }

  try {
    const sender = await resolveSender()
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
      status: 'accepted', timestamp: new Date(), sentBy: req.userId, studentId: await findStudentIdByPhone(waId),
    })
    const event = { _id: saved._id, wamid, direction: 'out', source: 'live', waId, type, text: saved.text, timestamp: saved.timestamp }
    for (const role of ['super_admin', 'admin']) emitToRole(role, 'whatsapp_message', event)
    await logActivity({ level: 'info', category: 'portal', action: 'whatsapp_sent', message: `WhatsApp ${type} sent to ${waId}`, req })
    res.status(201).json({ message: saved })
  } catch (err) {
    if (err instanceof GraphError) return res.status(502).json({ error: err.message })
    console.error('Send WhatsApp error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getTemplates(_req, res) {
  try {
    const sender = await resolveSender()
    if (!sender) return res.json({ templates: [] })
    res.json({ templates: await listTemplates(sender.wabaId, sender.token) })
  } catch (err) {
    if (err instanceof GraphError) return res.status(502).json({ error: err.message })
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
  if (typeof body !== 'string' || !body.trim() || body.length > 1024) {
    return res.status(400).json({ error: 'Message body is required (max 1024 characters)' })
  }

  // {{1}}, {{2}}… need one example value each, or Meta rejects the template
  const vars = [...new Set(body.match(/\{\{\d+\}\}/g) || [])]
  const ex = Array.isArray(examples) ? examples.map(v => String(v ?? '').trim()) : []
  if (vars.length && ex.slice(0, vars.length).filter(Boolean).length < vars.length) {
    return res.status(400).json({ error: `Give an example value for each of the ${vars.length} variable(s)` })
  }

  try {
    const sender = await resolveSender()
    if (!sender) return res.status(503).json({ error: 'No WhatsApp number is connected and no test number is configured' })
    const component = { type: 'BODY', text: body.trim() }
    if (vars.length) component.example = { body_text: [ex.slice(0, vars.length)] }
    const created = await createTemplate(sender.wabaId, sender.token, {
      name, category, language: String(language), components: [component],
    })
    await logActivity({ level: 'info', category: 'portal', action: 'whatsapp_template_created', message: `WhatsApp template ${name} submitted`, req })
    res.status(201).json({ template: { id: created.id, name, category: created.category || category, status: created.status || 'PENDING', language } })
  } catch (err) {
    if (err instanceof GraphError) return res.status(502).json({ error: err.message })
    console.error('Create WhatsApp template error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

import WhatsappConnection from '../models/WhatsappConnection.js'
import { encryptSecret, decryptSecret } from '../utils/totp.js'
import { logActivity } from '../utils/activityLogger.js'
import {
  META_APP_ID, WHATSAPP_ES_CONFIG_ID, GRAPH_VERSION, GraphError,
  exchangeCodeForToken, listPhoneNumbers, subscribeApp, unsubscribeApp, requestAppSync,
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

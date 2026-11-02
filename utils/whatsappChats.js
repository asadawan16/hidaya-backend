import WhatsappChat from '../models/WhatsappChat.js'
import WhatsappMessage from '../models/WhatsappMessage.js'
import { getPortalNamespace } from '../config/socket.js'

/*
 * Keeps WhatsappChat (the chat list) in step with WhatsappMessage.
 *
 * Every path that stores a message — the webhook, a portal reply, a class
 * reminder — calls touchChat(waId) afterwards. The row is recomputed from the
 * messages rather than incremented, so a missed or doubled call can't leave it
 * wrong for longer than the next message.
 *
 * Live updates go to the `whatsapp-chats` socket room (everyone holding
 * whatsapp.chat, see config/socket.js) as `whatsapp_chat_activity { chatId }`
 * and nothing else: staff are not allowed the number or fee messages, so the
 * event carries no content and the page refetches through the API, which
 * applies those rules.
 */

export const CHAT_ROOM = 'whatsapp-chats'
export const WINDOW_MS = 24 * 60 * 60 * 1000

// Inbound and not yet read by anyone on the team. The phone's history replay
// is old conversation, not new work, so it never counts.
export const UNREAD = { direction: 'in', readByStaffAt: null, source: { $ne: 'history' } }

export async function syncChat(waId, { contactName = '' } = {}) {
  const [last, lastIn, named, linked, unreadCount] = await Promise.all([
    WhatsappMessage.findOne({ waId }).sort({ timestamp: -1, _id: -1 }).select('_id timestamp').lean(),
    WhatsappMessage.findOne({ waId, direction: 'in' }).sort({ timestamp: -1 }).select('timestamp').lean(),
    contactName ? null : WhatsappMessage.findOne({ waId, direction: 'in', contactName: { $nin: ['', null] } }).sort({ timestamp: -1 }).select('contactName').lean(),
    WhatsappMessage.findOne({ waId, studentId: { $ne: null } }).sort({ timestamp: -1 }).select('studentId').lean(),
    WhatsappMessage.countDocuments({ waId, ...UNREAD }),
  ])
  if (!last) {
    await WhatsappChat.deleteOne({ waId })
    return null
  }

  const set = {
    lastMessage: last._id,
    lastMessageAt: last.timestamp,
    lastInboundAt: lastIn?.timestamp || null,
    unreadCount,
  }
  const name = contactName || named?.contactName
  if (name) set.contactName = name
  if (linked?.studentId) set.studentId = linked.studentId

  try {
    return await WhatsappChat.findOneAndUpdate({ waId }, { $set: set }, { upsert: true, new: true }).lean()
  } catch (err) {
    // Two messages from a new contact at once: both upserts raced, one lost. The row exists now.
    if (err?.code !== 11000) throw err
    return WhatsappChat.findOneAndUpdate({ waId }, { $set: set }, { new: true }).lean()
  }
}

export function announceChat(chatId) {
  const portal = getPortalNamespace()
  if (portal && chatId) portal.to(CHAT_ROOM).emit('whatsapp_chat_activity', { chatId: String(chatId) })
}

// Recompute + tell the open WhatsApp Chats pages. Never throws: a chat-list
// hiccup must not fail the webhook or a send that already went out.
export async function touchChat(waId, { contactName = '', announce = true } = {}) {
  try {
    const chat = await syncChat(waId, { contactName })
    if (chat && announce) announceChat(chat._id)
    return chat
  } catch (err) {
    console.error('WhatsApp chat summary update failed:', err)
    return null
  }
}

// A delivery tick changed — the row itself is unaffected, the open thread isn't
export async function announceChatFor(waId) {
  try {
    const chat = await WhatsappChat.findOne({ waId }).select('_id').lean()
    if (chat) announceChat(chat._id)
  } catch { /* ticks are cosmetic */ }
}

// Every contact that has messages but no chat row yet — e.g. messages stored
// before the chat list existed. Exported for scripts; returns how many it built.
export async function rebuildWhatsappChats({ all = false } = {}) {
  const [waIds, existing] = await Promise.all([
    WhatsappMessage.distinct('waId'),
    all ? [] : WhatsappChat.distinct('waId'),
  ])
  const have = new Set(existing)
  let built = 0
  for (const waId of waIds) {
    if (have.has(waId)) continue
    await syncChat(waId)
    built++
  }
  return built
}

// Once per process, before the first chat list is served
let backfill = null
export function ensureChats() {
  if (!backfill) {
    backfill = rebuildWhatsappChats().catch(err => {
      backfill = null // try again on the next request
      throw err
    })
  }
  return backfill
}

export function replyWindow(lastInboundAt, now = Date.now()) {
  if (!lastInboundAt) return { open: false, closesAt: null }
  const closesAt = new Date(new Date(lastInboundAt).getTime() + WINDOW_MS)
  return { open: closesAt.getTime() > now, closesAt }
}

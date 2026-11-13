import mongoose from 'mongoose'
import WhatsappChat from '../models/WhatsappChat.js'
import WhatsappMessage from '../models/WhatsappMessage.js'
import Student from '../models/Student.js'
import { emitToRole } from '../config/socket.js'
import { logActivity } from '../utils/activityLogger.js'
import { contactLabelFor } from '../utils/waNumber.js'
import { isFeeMessage, mentionsFees } from '../utils/feeFilter.js'
import { maskPhoneNumbers, containsPhoneNumber } from '../utils/phoneMask.js'
import { UNREAD, touchChat, ensureChats, replyWindow, visibleSince, announceChat } from '../utils/whatsappChats.js'
import { chatLevel, chatScope, inScope } from '../utils/whatsappAccess.js'
import { resolveSender } from './portalWhatsappController.js'
import { findStudentIdByPhone } from './whatsappWebhookController.js'
import {
  GraphError, sendMessage, listTemplates, markMessageRead, uploadMedia, downloadMedia,
} from '../services/whatsappGraph.js'
import { plainFailure, plainWhatsappError } from '../utils/whatsappErrors.js'
import {
  setCustomName, refreshChatNames, importContacts, contactBookSummary, cleanName, IMPORT_MAX, NAME_MAX,
} from '../utils/whatsappContacts.js'

/*
 * /api/portal/whatsapp-chats — the team's WhatsApp, as the academy.
 *
 * Two views of the same chats, picked per request from the caller's permissions
 * (levels in utils/whatsappAccess.js):
 *
 *   whatsapp.chat_own          STAFF view, limited to the chats of the tutor's
 *                              own students — any other chat is "not found".
 *   whatsapp.chat              STAFF view (QCI, coordinators…). The contact's
 *                              number is never sent — not in a chat, a search
 *                              match or a socket event; a chat is addressed by
 *                              its _id. A message that mentions fees
 *                              (utils/feeFilter.js) arrives as a placeholder
 *                              with no text and no media. A phone number
 *                              written in a message, caption or file name
 *                              arrives as "[number hidden]"
 *                              (utils/phoneMask.js). Text replies only, and
 *                              never with a phone number in them.
 *   whatsapp.chat + .inbox     FULL view (admin). Numbers, every message,
 *                              templates and photos / documents.
 *
 * Both are enforced HERE; the page only renders what it is given.
 *
 * Names: a chat is shown under the name its number is saved under in the
 * academy's contact book (typed here, synced from the office phone, or from an
 * uploaded contacts file — utils/whatsappContacts.js), else the student's name,
 * else the WhatsApp profile name. Only the full view can change them.
 *
 * Reading is shared: the chat list is a team inbox, so a message one person
 * reads is read for everyone. Staff never mark a fee message read — they
 * can't see it — so it stays unread until someone with the full view opens it.
 */

const fullView = (req) => chatLevel(req.userPermissions) === 'full'
const isId = (v) => mongoose.isValidObjectId(v)
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A WhatsApp profile name is whatever the contact typed — if that's their
// number, it's still the number.
const safeName = (name, full) => (!full && (String(name || '').match(/\d/g) || []).length >= 6 ? '' : (name || ''))

const STUDENT_FIELDS = 'name rollNo status courseLabels guardians whatsappNumber phone'

function describeStudent(student) {
  if (!student) return null
  return { _id: student._id, name: student.name, rollNo: student.rollNo || '', status: student.status || '', courses: student.courseLabels || [] }
}

function describeChat(chat, { full, student, unread }) {
  const contactName = safeName(chat.contactName, full)
  const savedName = safeName(chat.savedName, full)
  return {
    _id: chat._id,
    name: savedName || student?.name || contactName || (full ? `+${chat.waId}` : 'Unknown contact'),
    savedName,
    nameSource: savedName ? (chat.nameSource || '') : '',
    label: student ? (contactLabelFor(student, chat.waId) || 'Contact') : '',
    contactName,
    student: describeStudent(student),
    ...(full ? { waId: chat.waId } : {}),
    lastMessageAt: chat.lastMessageAt,
    unread: unread ?? chat.unreadCount ?? 0,
    window: replyWindow(chat.lastInboundAt),
  }
}

// ── Template bodies (so a template message reads as the parent saw it) ──────
let templateCache = { at: 0, bodies: {}, templates: [] }
const TEMPLATE_TTL_MS = 10 * 60 * 1000

async function loadTemplates({ fresh = false } = {}) {
  if (!fresh && Date.now() - templateCache.at < TEMPLATE_TTL_MS) return templateCache
  try {
    const sender = await resolveSender()
    const templates = sender ? await listTemplates(sender.wabaId, sender.token) : []
    const bodies = {}
    for (const t of templates) {
      const body = t.components?.find(c => c.type === 'BODY')?.text
      if (body && !bodies[t.name]) bodies[t.name] = body
    }
    templateCache = { at: Date.now(), bodies, templates }
  } catch {
    templateCache.at = Date.now() - TEMPLATE_TTL_MS + 60_000 // keep what we had, retry in a minute
  }
  return templateCache
}

const fillTemplate = (body, values) => body.replace(/\{\{(\d+)\}\}/g, (m, n) => values[Number(n) - 1] ?? m)

/*
 * Templates are stored two ways: class reminders keep the filled-in body, and
 * the WhatsApp page's sender keeps only the values ("Ali · 8:30 PM"). Fill the
 * second kind in; leave text that already reads as the body alone.
 */
function templateText(body, stored) {
  if (!body) return stored || ''
  const opening = body.split(/\{\{\d+\}\}/)[0].trim().slice(0, 24)
  if (stored && opening && stored.includes(opening)) return stored
  return fillTemplate(body, String(stored || '').split(' · '))
}

function describeMessage(m, { full, bodies }) {
  const text = m.templateName ? templateText(bodies[m.templateName], m.text) : (m.text || '')
  const base = {
    _id: m._id,
    direction: m.direction,
    source: m.source,
    timestamp: m.timestamp,
    status: m.status,
    sentBy: m.sentBy ? { _id: m.sentBy._id, name: m.sentBy.displayName || m.sentBy.email || 'Staff' } : null,
  }
  if (!full && isFeeMessage({ ...m, text })) return { ...base, type: 'hidden', hidden: 'fees' }
  // Staff never see a phone number, not even one typed into a message
  const clean = full ? (s) => s : maskPhoneNumbers
  return {
    ...base,
    type: m.type,
    text: clean(text),
    templateName: m.templateName || '',
    media: m.media?.id || m.media?.mimeType
      ? { mimeType: m.media.mimeType || '', filename: clean(m.media.filename || ''), available: Boolean(m.media.id) }
      : null,
    error: m.status === 'failed' ? plainFailure(m) : '',
  }
}

// ── List ────────────────────────────────────────────────────────────────────
const PAGE = 30

export async function listChats(req, res) {
  const full = fullView(req)
  const { filter = 'all', q = '', cursor = '' } = req.query
  try {
    await ensureChats()

    // A chat removed from the portal has no lastMessageAt until something new arrives
    const and = [{ lastMessageAt: { $ne: null } }]
    const scope = await chatScope(req)
    const scoped = scope ? { studentId: { $in: scope.map(id => new mongoose.Types.ObjectId(id)) } } : null
    if (scoped) and.push(scoped)
    // Archived chats live under their own filter and nowhere else
    and.push(filter === 'archived' ? { archivedAt: { $ne: null } } : { archivedAt: null })
    if (filter === 'students') and.push({ studentId: { $ne: null } })
    if (filter === 'unread') and.push({ unreadCount: { $gt: 0 } })

    const term = String(q).trim().slice(0, 60)
    if (term) {
      const re = new RegExp(escapeRe(term), 'i')
      const students = await Student.find({ $or: [{ name: re }, { rollNo: re }] }).select('_id').limit(300).lean()
      const or = [{ studentId: { $in: students.map(s => s._id) } }]
      // Only the full view may find a chat by its number — for staff, digit
      // searches would be a way to test what someone's number is (a saved or
      // profile name can have the number in it too)
      const digits = term.replace(/\D/g, '')
      if (full || digits.length < 3) or.push({ contactName: re }, { savedName: re })
      // A number typed the local way ("0300 123…") still finds the international waId
      if (full && digits.length >= 3) or.push({ waId: new RegExp(digits.replace(/^0+/, '') || digits) })
      and.push({ $or: or })
    }

    // Cursor = "<lastMessageAt ms>_<_id>" of the last row on the previous page
    const [cMs, cId] = String(cursor).split('_')
    if (Number(cMs) && isId(cId)) {
      const at = new Date(Number(cMs))
      and.push({ $or: [{ lastMessageAt: { $lt: at } }, { lastMessageAt: at, _id: { $lt: new mongoose.Types.ObjectId(cId) } }] })
    }

    const [rows, archivedCount] = await Promise.all([
      WhatsappChat.find({ $and: and })
      .sort({ lastMessageAt: -1, _id: -1 }).limit(PAGE + 1)
      .populate('studentId', STUDENT_FIELDS)
      .populate({ path: 'lastMessage', populate: { path: 'sentBy', select: 'displayName email' } })
      .lean(),
      // For the "Archived" filter's count (first page only — it doesn't change while paging)
      cursor ? null : WhatsappChat.countDocuments({ lastMessageAt: { $ne: null }, archivedAt: { $ne: null }, ...(scoped || {}) }),
    ])
    const hasMore = rows.length > PAGE
    const page = rows.slice(0, PAGE)
    const lastRow = page[page.length - 1]

    // Staff unread counts leave out the fee messages they will never be shown
    let staffUnread = null
    if (!full) {
      const waIds = page.filter(c => c.unreadCount > 0).map(c => c.waId)
      staffUnread = new Map()
      if (waIds.length) {
        const unread = await WhatsappMessage.find({ waId: { $in: waIds }, ...UNREAD }).select('waId text templateName media.filename').lean()
        for (const m of unread) if (!isFeeMessage(m)) staffUnread.set(m.waId, (staffUnread.get(m.waId) || 0) + 1)
      }
    }

    const { bodies } = await loadTemplates()
    let chats = page.map(c => {
      const student = c.studentId || null
      const chat = describeChat(c, {
        full, student, unread: staffUnread ? (staffUnread.get(c.waId) || 0) : c.unreadCount,
      })
      chat.preview = c.lastMessage ? describeMessage(c.lastMessage, { full, bodies }) : null
      return chat
    })
    if (!full && filter === 'unread') chats = chats.filter(c => c.unread > 0)

    res.json({
      chats,
      nextCursor: hasMore && lastRow ? `${new Date(lastRow.lastMessageAt).getTime()}_${lastRow._id}` : null,
      view: full ? 'full' : 'staff',
      scope: scope ? 'own' : 'all',
      archivedCount,
    })
  } catch (err) {
    console.error('List WhatsApp chats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ── One chat ────────────────────────────────────────────────────────────────
async function loadChat(req, res) {
  if (!isId(req.params.id)) { res.status(404).json({ error: 'Chat not found' }); return null }
  const chat = await WhatsappChat.findById(req.params.id).lean()
  if (!chat) { res.status(404).json({ error: 'Chat not found' }); return null }
  // The student's number may have been added since the messages arrived
  if (!chat.studentId) {
    const studentId = await findStudentIdByPhone(chat.waId)
    if (studentId) {
      await WhatsappChat.updateOne({ _id: chat._id }, { $set: { studentId } })
      chat.studentId = studentId
    }
  }
  // Own-students access: someone else's chat doesn't exist, as far as this caller knows
  if (!inScope(await chatScope(req), chat.studentId)) { res.status(404).json({ error: 'Chat not found' }); return null }
  return chat
}

const MESSAGE_PAGE = 40

export async function getChatMessages(req, res) {
  const full = fullView(req)
  try {
    const chat = await loadChat(req, res)
    if (!chat) return

    const query = { waId: chat.waId, ...visibleSince(chat) }
    if (isId(req.query.before)) {
      const pivot = await WhatsappMessage.findById(req.query.before).select('timestamp waId').lean()
      if (pivot && pivot.waId === chat.waId) {
        query.$or = [{ timestamp: { $lt: pivot.timestamp } }, { timestamp: pivot.timestamp, _id: { $lt: pivot._id } }]
      }
    }

    const [rows, student, { bodies }] = await Promise.all([
      WhatsappMessage.find(query).sort({ timestamp: -1, _id: -1 }).limit(MESSAGE_PAGE + 1)
        .populate('sentBy', 'displayName email').lean(),
      chat.studentId ? Student.findById(chat.studentId).select(STUDENT_FIELDS).lean() : null,
      loadTemplates(),
    ])
    const hasMore = rows.length > MESSAGE_PAGE
    const messages = rows.slice(0, MESSAGE_PAGE).reverse().map(m => describeMessage(m, { full, bodies }))

    let unread = chat.unreadCount
    if (!full && unread) {
      const pending = await WhatsappMessage.find({ waId: chat.waId, ...UNREAD }).select('text templateName media.filename').lean()
      unread = pending.filter(m => !isFeeMessage(m)).length
    }

    res.json({
      chat: {
        ...describeChat(chat, { full, student, unread }),
        canSendTemplates: full,
        canSendMedia: full,
        // Archive / remove from the portal: team-wide, so the full inbox only
        canManage: full,
        archived: Boolean(chat.archivedAt),
      },
      messages,
      hasMore,
    })
  } catch (err) {
    console.error('Get WhatsApp chat error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/*
 * Mark what this viewer can see as read. Sends the contact blue ticks for the
 * newest one (best effort — WhatsApp marks everything before it read too).
 */
async function markChatRead(chat, full) {
  const unread = await WhatsappMessage.find({ waId: chat.waId, ...UNREAD, ...visibleSince(chat) })
    .select('_id wamid source timestamp text templateName media.filename').lean()
  const readable = full ? unread : unread.filter(m => !isFeeMessage(m))
  if (!readable.length) return 0

  await WhatsappMessage.updateMany({ _id: { $in: readable.map(m => m._id) }, readByStaffAt: null }, { $set: { readByStaffAt: new Date() } })
  await touchChat(chat.waId)

  const newest = readable.filter(m => m.source === 'live').sort((a, b) => b.timestamp - a.timestamp)[0]
  if (newest) {
    resolveSender()
      .then(s => s && markMessageRead(s.phoneNumberId, s.token, newest.wamid))
      .catch(err => console.warn('WhatsApp read receipt not sent:', err.message))
  }
  return readable.length
}

export async function readChat(req, res) {
  try {
    const chat = await loadChat(req, res)
    if (!chat) return
    res.json({ marked: await markChatRead(chat, fullView(req)) })
  } catch (err) {
    console.error('Read WhatsApp chat error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ── Sending ─────────────────────────────────────────────────────────────────
const WINDOW_CLOSED = 'More than 24 hours have passed since this contact last wrote, so WhatsApp only allows an approved template now. A free-text reply opens again once they message the academy.'
const RE_ENGAGEMENT = 131047

function friendlySendError(err) {
  if (Number(err.code) === RE_ENGAGEMENT) return WINDOW_CLOSED
  return plainWhatsappError(err.code, err.message)
}

async function newestInboundAt(waId) {
  const m = await WhatsappMessage.findOne({ waId, direction: 'in' }).sort({ timestamp: -1 }).select('timestamp').lean()
  return m?.timestamp || null
}

// Store an outbound message, update the chat and the admins' WhatsApp page
async function recordSent(req, chat, sender, doc, full) {
  const saved = await WhatsappMessage.create({
    direction: 'out', source: 'live', waId: chat.waId, phoneNumberId: sender.phoneNumberId,
    status: 'accepted', timestamp: new Date(), sentBy: req.userId, studentId: chat.studentId || null, ...doc,
  })
  // Replying means you read what you replied to
  if (!(await markChatRead(chat, full))) await touchChat(chat.waId)
  const event = { _id: saved._id, wamid: saved.wamid, direction: 'out', source: 'live', waId: chat.waId, type: saved.type, text: saved.text, timestamp: saved.timestamp, studentId: saved.studentId }
  for (const role of ['super_admin', 'admin']) emitToRole(role, 'whatsapp_message', event)
  const populated = await WhatsappMessage.findById(saved._id).populate('sentBy', 'displayName email').lean()
  return populated
}

export async function sendChatMessage(req, res) {
  const full = fullView(req)
  const { type = 'text', text, templateName, params } = req.body || {}
  if (!['text', 'template'].includes(type)) return res.status(400).json({ error: 'Unknown message type' })
  if (type === 'template' && !full) return res.status(403).json({ error: 'Only the admin inbox can send templates' })

  try {
    const chat = await loadChat(req, res)
    if (!chat) return

    let payload, doc
    if (type === 'text') {
      const body = typeof text === 'string' ? text.trim() : ''
      if (!body) return res.status(400).json({ error: 'Type a message' })
      if (body.length > 4096) return res.status(400).json({ error: 'WhatsApp messages are limited to 4,096 characters' })
      if (!full && mentionsFees(body)) {
        return res.status(422).json({ error: 'This message mentions fees or payments. Fee matters are handled by the admin, so it was not sent.', code: 'fee_topic' })
      }
      if (!full && containsPhoneNumber(body)) {
        return res.status(422).json({ error: 'This message contains a phone number. Contact details are not shared from here, so it was not sent.', code: 'phone_number' })
      }
      if (!replyWindow(await newestInboundAt(chat.waId)).open) {
        return res.status(409).json({ error: WINDOW_CLOSED, code: 'window_closed' })
      }
      payload = { to: chat.waId, type: 'text', text: { body, preview_url: false } }
      doc = { type: 'text', text: body }
    } else {
      const { templates } = await loadTemplates({ fresh: true })
      const tpl = templates.find(t => t.name === templateName && t.status === 'APPROVED')
      if (!tpl) return res.status(400).json({ error: 'Pick an approved template' })
      const tplBody = tpl.components?.find(c => c.type === 'BODY')?.text || ''
      if (tpl.components?.some(c => c.type === 'HEADER' && c.format && c.format !== 'TEXT')) {
        return res.status(400).json({ error: 'Templates with a photo, video or document header can\'t be sent from here' })
      }
      const count = new Set(tplBody.match(/\{\{\d+\}\}/g) || []).size
      const values = Array.isArray(params) ? params.map(v => String(v ?? '').trim()) : []
      if (values.slice(0, count).filter(Boolean).length < count) {
        return res.status(400).json({ error: `Fill in all ${count} value(s) for this template` })
      }
      payload = {
        to: chat.waId, type: 'template',
        template: {
          name: tpl.name, language: { code: tpl.language },
          ...(count ? { components: [{ type: 'body', parameters: values.slice(0, count).map(v => ({ type: 'text', text: v })) }] } : {}),
        },
      }
      doc = { type: 'template', templateName: tpl.name, text: fillTemplate(tplBody, values) }
    }

    // Last, so a refused message says why it was refused rather than "not connected"
    const sender = await resolveSender()
    if (!sender) return res.status(503).json({ error: 'No WhatsApp number is connected' })

    let wamid
    try {
      wamid = await sendMessage(sender.phoneNumberId, sender.token, payload)
    } catch (err) {
      if (err instanceof GraphError) {
        const closed = Number(err.code) === RE_ENGAGEMENT
        return res.status(closed ? 409 : 502).json({ error: friendlySendError(err), code: closed ? 'window_closed' : err.code })
      }
      throw err
    }

    const saved = await recordSent(req, chat, sender, { wamid, ...doc }, full)
    await logActivity({
      level: 'info', category: 'portal', action: 'whatsapp_chat_reply',
      message: `WhatsApp ${type} sent from WhatsApp Chats${chat.studentId ? '' : ` to ${full ? `+${chat.waId}` : 'a contact'}`}`, req,
      meta: { chatId: chat._id, studentId: chat.studentId || null, wamid },
    })
    res.status(201).json({ message: describeMessage(saved, { full, bodies: {} }) })
  } catch (err) {
    console.error('Send WhatsApp chat message error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// What WhatsApp accepts (Cloud API limits), by the file's MIME type
const MB = 1024 * 1024
const MEDIA_KINDS = [
  { kind: 'image', max: 5 * MB, types: ['image/jpeg', 'image/png'] },
  { kind: 'video', max: 16 * MB, types: ['video/mp4', 'video/3gpp'] },
  { kind: 'audio', max: 16 * MB, types: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'] },
  {
    kind: 'document', max: 16 * MB, types: [
      'application/pdf', 'text/plain',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  },
]
export const MEDIA_UPLOAD_LIMIT = '16mb'

// Raw file body; ?filename=&caption= (the route mounts express.raw for this one)
export async function sendChatMedia(req, res) {
  const full = fullView(req)
  const mimeType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const rule = MEDIA_KINDS.find(k => k.types.includes(mimeType))
  if (!rule) return res.status(415).json({ error: 'WhatsApp accepts JPG/PNG photos, MP4 video, audio, and PDF, Word, Excel, PowerPoint or text documents' })
  const buffer = req.body
  if (!Buffer.isBuffer(buffer) || !buffer.length) return res.status(400).json({ error: 'The file is empty' })
  if (buffer.length > rule.max) return res.status(413).json({ error: `WhatsApp limits a ${rule.kind} to ${rule.max / MB} MB` })

  const filename = String(req.query.filename || '').replace(/[\r\n"\\/]/g, '').slice(0, 120) || `${rule.kind}`
  const caption = String(req.query.caption || '').trim().slice(0, 1024)

  try {
    const chat = await loadChat(req, res)
    if (!chat) return
    if (!replyWindow(await newestInboundAt(chat.waId)).open) {
      return res.status(409).json({ error: WINDOW_CLOSED, code: 'window_closed' })
    }
    const sender = await resolveSender()
    if (!sender) return res.status(503).json({ error: 'No WhatsApp number is connected' })

    let wamid, mediaId
    try {
      mediaId = await uploadMedia(sender.phoneNumberId, sender.token, { buffer, mimeType, filename })
      const media = { id: mediaId }
      if (caption && rule.kind !== 'audio') media.caption = caption
      if (rule.kind === 'document') media.filename = filename
      wamid = await sendMessage(sender.phoneNumberId, sender.token, { to: chat.waId, type: rule.kind, [rule.kind]: media })
    } catch (err) {
      if (err instanceof GraphError) {
        const closed = Number(err.code) === RE_ENGAGEMENT
        return res.status(closed ? 409 : 502).json({ error: friendlySendError(err), code: closed ? 'window_closed' : err.code })
      }
      throw err
    }

    const saved = await recordSent(req, chat, sender, {
      wamid, type: rule.kind, text: rule.kind === 'audio' ? '' : caption, media: { id: mediaId, mimeType, filename },
    }, full)
    await logActivity({
      level: 'info', category: 'portal', action: 'whatsapp_chat_media',
      message: `WhatsApp ${rule.kind} sent from WhatsApp Chats`, req, meta: { chatId: chat._id, wamid },
    })
    res.status(201).json({ message: describeMessage(saved, { full, bodies: {} }) })
  } catch (err) {
    console.error('Send WhatsApp media error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ── Media download (photos, voice notes, documents) ─────────────────────────
// The browser can't call Meta (the token stays here), so the file is relayed.
export async function getChatMedia(req, res) {
  const full = fullView(req)
  if (!isId(req.params.messageId)) return res.status(404).json({ error: 'File not found' })
  try {
    const m = await WhatsappMessage.findById(req.params.messageId).select('waId media text templateName timestamp').lean()
    if (!m?.media?.id) return res.status(404).json({ error: 'File not found' })
    const owner = await WhatsappChat.findOne({ waId: m.waId }).select('clearedAt').lean()
    if (owner?.clearedAt && m.timestamp <= owner.clearedAt) return res.status(404).json({ error: 'File not found' })
    const scope = await chatScope(req)
    if (scope && !(await WhatsappChat.exists({ waId: m.waId, studentId: { $in: scope } }))) {
      return res.status(404).json({ error: 'File not found' })
    }
    if (!full && isFeeMessage(m)) return res.status(403).json({ error: 'Hidden — this message mentions fees' })

    const sender = await resolveSender()
    if (!sender) return res.status(503).json({ error: 'No WhatsApp number is connected' })

    let file
    try {
      file = await downloadMedia(m.media.id, sender.token)
    } catch (err) {
      if (err instanceof GraphError) return res.status(410).json({ error: 'This file is no longer available from WhatsApp' })
      throw err
    }
    const name = (m.media.filename || 'file').replace(/[^\w.\- ]/g, '_')
    res.set({
      'Content-Type': m.media.mimeType || file.mimeType,
      'Content-Length': String(file.buffer.length),
      'Content-Disposition': `inline; filename="${name}"`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    })
    res.send(file.buffer)
  } catch (err) {
    console.error('WhatsApp media download error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Approved templates for the admin inbox's template picker
export async function listChatTemplates(_req, res) {
  try {
    const { templates } = await loadTemplates({ fresh: true })
    res.json({
      templates: templates
        .filter(t => t.status === 'APPROVED' && !t.components?.some(c => c.type === 'HEADER' && c.format && c.format !== 'TEXT'))
        .map(t => {
          const body = t.components?.find(c => c.type === 'BODY')?.text || ''
          return { name: t.name, language: t.language, category: t.category, body, vars: new Set(body.match(/\{\{\d+\}\}/g) || []).size }
        }),
    })
  } catch (err) {
    console.error('List WhatsApp chat templates error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ── Archive / remove (full inbox only — both change the list for the whole team) ──
export async function archiveChat(req, res) {
  try {
    const chat = await loadChat(req, res)
    if (!chat) return
    const archived = req.body?.archived !== false
    await WhatsappChat.updateOne({ _id: chat._id }, {
      $set: archived ? { archivedAt: new Date(), archivedBy: req.userId } : { archivedAt: null, archivedBy: null },
    })
    announceChat(chat._id)
    res.json({ archived })
  } catch (err) {
    console.error('Archive WhatsApp chat error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/*
 * Remove a chat from the portal. Nothing is deleted from WhatsApp, the phone
 * or the database: the chat leaves every portal list and its messages stop
 * being shown, up to now. A new message brings the chat back with only what
 * comes after. Unread messages in it are marked read so they stop counting.
 */
export async function removeChat(req, res) {
  try {
    const chat = await loadChat(req, res)
    if (!chat) return
    const now = new Date()
    await WhatsappMessage.updateMany({ waId: chat.waId, ...UNREAD, timestamp: { $lte: now } }, { $set: { readByStaffAt: now } })
    await WhatsappChat.updateOne({ _id: chat._id }, {
      $set: { clearedAt: now, clearedBy: req.userId, archivedAt: null, archivedBy: null },
    })
    await touchChat(chat.waId)
    await logActivity({
      level: 'info', category: 'portal', action: 'whatsapp_chat_removed',
      message: `WhatsApp chat with ${chat.waId} removed from the portal`, req,
    })
    res.json({ removed: true })
  } catch (err) {
    console.error('Remove WhatsApp chat error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ── Contact names (full inbox only — the names are the whole team's) ────────

// PUT /:id/name { name } — save this number under a name ('' goes back to the
// phone's / file's / profile name)
export async function renameChat(req, res) {
  const raw = req.body?.name
  if (raw != null && typeof raw !== 'string') return res.status(400).json({ error: 'Type a name' })
  if (String(raw || '').trim().length > NAME_MAX) return res.status(400).json({ error: `Keep the name under ${NAME_MAX} characters` })
  try {
    const chat = await loadChat(req, res)
    if (!chat) return
    const key = await setCustomName(chat.waId, raw || '', req.userId)
    if (!key) return res.status(400).json({ error: "This chat's number can't be saved" })
    await refreshChatNames([key])
    announceChat(chat._id)
    const fresh = await WhatsappChat.findById(chat._id).lean()
    const name = cleanName(raw)
    await logActivity({
      level: 'info', category: 'portal', action: 'whatsapp_contact_named',
      message: name ? `WhatsApp contact +${chat.waId} saved as "${name}"` : `Saved name removed from WhatsApp contact +${chat.waId}`, req,
    })
    res.json({ savedName: fresh?.savedName || '', nameSource: fresh?.nameSource || '' })
  } catch (err) {
    console.error('Rename WhatsApp chat error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// POST /contacts/import { contacts: [{ name, phone }], overwrite } — a contacts
// file the browser has already read (.vcf / .csv; up to IMPORT_MAX numbers a call)
export async function importContactList(req, res) {
  const { contacts, overwrite } = req.body || {}
  if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'No contacts were found in that file' })
  if (contacts.length > IMPORT_MAX) return res.status(413).json({ error: `Send at most ${IMPORT_MAX.toLocaleString('en')} contacts at a time` })
  try {
    const result = await importContacts(contacts, { overwrite: overwrite === true })
    const renamed = await refreshChatNames(result.keys)
    for (const id of renamed) announceChat(id)
    await logActivity({
      level: 'info', category: 'portal', action: 'whatsapp_contacts_imported',
      message: `WhatsApp contacts file: ${result.added} added, ${result.updated} updated, ${renamed.length} chat name(s) changed`, req,
    })
    const { keys, ...counts } = result
    res.json({ ...counts, chatsRenamed: renamed.length, summary: await contactBookSummary() })
  } catch (err) {
    console.error('Import WhatsApp contacts error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /contacts/summary — how many saved names there are, and from where
export async function getContactSummary(_req, res) {
  try {
    res.json(await contactBookSummary())
  } catch (err) {
    console.error('WhatsApp contact summary error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

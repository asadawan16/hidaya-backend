import mongoose from 'mongoose'
import ClassSession from '../models/ClassSession.js'
import ClassReminder from '../models/ClassReminder.js'
import TutorProfile from '../models/TutorProfile.js'
import StudentClassLink from '../models/StudentClassLink.js'
import User from '../models/User.js'
import Role from '../models/Role.js'
import WhatsappMessage from '../models/WhatsappMessage.js'
import WhatsappReminderSettings, { REMINDER_FIELDS } from '../models/WhatsappReminderSettings.js'
import { resolveSender } from './portalWhatsappController.js'
import { GraphError, sendMessage, listTemplates, createTemplate } from '../services/whatsappGraph.js'
import { resolveStudentRecipient } from '../utils/waNumber.js'
import { emitToRole, emitToUser } from '../config/socket.js'
import { logActivity } from '../utils/activityLogger.js'
import { isStudentAccount } from '../middleware/studentScope.js'

/*
 * WhatsApp class reminders.
 *
 * A tutor who has been given `whatsapp.reminder` (per person, from the WhatsApp
 * page) gets a "Send reminder" button on each of their own classes. It opens
 * when the class's start time arrives and closes when the class ends, and each
 * class can be reminded ONCE (ClassReminder.dedupeKey / sessionId are unique).
 * The message is the approved template chosen on the WhatsApp page, sent from
 * the academy's number to the student's WhatsApp recipient — the tutor never
 * sees the number.
 *
 * Tutor:  GET  /portal/class-reminders?sessionIds=a,b   state of each class
 *         POST /portal/class-reminders/:sessionId        send
 * Admin (whatsapp.manage, under /portal/whatsapp/reminders):
 *         settings · recommended template · who may send · the reminder log
 */

const REMINDER_PERM = 'whatsapp.reminder'
const PKT_OFFSET_MIN = 5 * 60 // Asia/Karachi is UTC+5 all year
const EARLY_TOLERANCE_MS = 60_000 // a device clock a minute fast shouldn't be refused
const CLAIM_STALE_MS = 2 * 60_000
const MAX_SESSION_IDS = 100
const ACADEMY_NAME = 'Hidaya Online'
const STUDENT_FIELDS = 'name rollNo status guardians whatsappNumber phone country timezone'

const TRACK_LABEL = {
  nazra: 'Nazra', hifz: 'Hifz', tafseer: 'Tafseer', tajweed: 'Tajweed', translation: 'Translation', qaida: 'Noorani Qaida',
}

export const FIELD_CATALOG = [
  { key: 'student_first_name', label: "Student's first name", example: 'Hamza' },
  { key: 'student_name', label: "Student's full name", example: 'Hamza Raza' },
  { key: 'class_time', label: "Class time (student's own time zone)", example: '8:30 PM' },
  { key: 'class_date', label: "Class day (student's own time zone)", example: 'Monday 2 November' },
  { key: 'course', label: 'Course', example: 'Hifz' },
  { key: 'tutor_name', label: "Tutor's name", example: 'Bilal Ahmed' },
  { key: 'class_link', label: "Student's class link", example: 'https://hidaya.online/my-class/hid518' },
  { key: 'academy_name', label: 'Academy name', example: ACADEMY_NAME },
]
const FIELD_LABEL = Object.fromEntries(FIELD_CATALOG.map(f => [f.key, f.label]))

// What "Create recommended template" submits to Meta
export const RECOMMENDED_TEMPLATE = {
  name: 'class_reminder',
  language: 'en_US',
  category: 'UTILITY',
  body: "Assalamu alaikum! This is a reminder that {{1}}'s Quran class with Hidaya Online is due at {{2}} today. Please join now, in sha Allah.",
  params: ['student_first_name', 'class_time'],
}

// ── Time ────────────────────────────────────────────────────────────────────
// Sessions are dated at midnight UTC of their PKT calendar day and timed in PKT
// wall-clock, so the absolute instants never depend on the server's zone.
const toMin = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number)
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null
}

export function classWindow(session) {
  const base = new Date(session?.date).getTime()
  const st = toMin(session?.scheduledStart)
  if (!Number.isFinite(base) || st == null) return null
  const day = new Date(base).toISOString().slice(0, 10)
  const dayStart = Date.parse(`${day}T00:00:00Z`)
  const opensAt = dayStart + (st - PKT_OFFSET_MIN) * 60_000
  const en = toMin(session.scheduledEnd)
  let closesAt = en == null ? opensAt + 30 * 60_000 : dayStart + (en - PKT_OFFSET_MIN) * 60_000
  if (closesAt <= opensAt) closesAt += 24 * 60 * 60_000 // the class crosses midnight
  return { day, opensAt, closesAt }
}

// The class itself, independent of the session _id — a session deleted and
// regenerated is still the same class and must not be reminded twice.
const dedupeKeyOf = (session, win) => `${session.studentId?._id || session.studentId}:${win.day}:${session.scheduledStart}`

function safeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0)
    return tz
  } catch {
    return 'Asia/Karachi'
  }
}

// ── Who is asking ───────────────────────────────────────────────────────────
// linkedTutorId is the link; TutorProfile.userId is the fallback some older
// tutor accounts only have.
async function callerTutorId(req) {
  if (req.user.linkedTutorId) return req.user.linkedTutorId
  const tp = await TutorProfile.findOne({ userId: req.userId }).select('_id').lean()
  return tp?._id || null
}

// ── Can reminders go out at all? ────────────────────────────────────────────
const UNAVAILABLE_MESSAGE = {
  disabled: 'WhatsApp reminders are switched off. Ask the admin to turn them on.',
  not_configured: 'WhatsApp reminders are not set up yet. Ask the admin to choose a reminder template.',
  not_connected: "The academy's WhatsApp number is not connected. Ask the admin to connect it.",
}

async function reminderAvailability() {
  const settings = await WhatsappReminderSettings.findOne({ key: 'default' }).lean()
  if (!settings?.enabled) return { ok: false, reason: 'disabled' }
  if (!settings.templateName) return { ok: false, reason: 'not_configured' }
  const sender = await resolveSender()
  if (!sender) return { ok: false, reason: 'not_connected' }
  return { ok: true, settings, sender }
}

// ── Can THIS class be reminded right now? ───────────────────────────────────
const BLOCK_MESSAGE = {
  class_over: 'This class is over, so its reminder can no longer be sent.',
  not_yet: 'The reminder can be sent once the class time arrives.',
  student_inactive: 'This student is on leave or has left, so no reminder is sent.',
  no_number: 'There is no WhatsApp number on file for this student. Ask the office to add one.',
  invalid_number: "The student's WhatsApp number on file isn't in international format. Ask the office to correct it.",
  no_time: 'This class has no valid start time.',
}

function assess(session, now) {
  const win = classWindow(session)
  if (!win) return { block: 'no_time', win: null }
  if (session.status === 'completed' || session.status === 'missed' || now >= win.closesAt) return { block: 'class_over', win }
  if (now < win.opensAt - EARLY_TOLERANCE_MS) return { block: 'not_yet', win }
  const student = session.studentId
  if (!student || student.status === 'leave' || student.status === 'left') return { block: 'student_inactive', win }
  const { recipient, reason } = resolveStudentRecipient(student)
  if (!recipient) return { block: reason === 'invalid' ? 'invalid_number' : 'no_number', win }
  return { block: '', win, recipient }
}

// Everything the tutor's screen needs about one class's reminder — and nothing
// about the recipient's number.
function tutorView(session, reminder, delivery, now) {
  const { block, win, recipient } = assess(session, now)
  const view = {
    opensAt: win?.opensAt ?? null,
    closesAt: win?.closesAt ?? null,
    state: 'none',
    canSend: false,
    block: '',
  }
  if (reminder && !(reminder.status === 'sending' && isStale(reminder, now))) {
    view.state = reminder.status
    view.sentAt = reminder.sentAt || null
    view.recipient = reminder.recipientLabel
    view.delivery = delivery?.status || (reminder.status === 'sent' ? 'accepted' : null)
    if (delivery?.status === 'failed') view.failedReason = delivery.statusErrors?.[0]?.title || 'Not delivered'
    return view
  }
  // A block that only lifts with time is still worth showing as "opens at"
  view.block = block
  view.canSend = !block
  if (recipient) view.recipient = recipient.label
  return view
}

const isStale = (reminder, now) => reminder.status === 'sending' && now - new Date(reminder.claimedAt).getTime() > CLAIM_STALE_MS

async function remindersFor(sessions) {
  const keys = []
  for (const s of sessions) {
    const win = classWindow(s)
    if (win) keys.push(dedupeKeyOf(s, win))
  }
  const reminders = await ClassReminder.find({
    $or: [{ sessionId: { $in: sessions.map(s => s._id) } }, { dedupeKey: { $in: keys } }],
  }).lean()
  const wamids = reminders.map(r => r.wamid).filter(Boolean)
  const messages = wamids.length
    ? await WhatsappMessage.find({ wamid: { $in: wamids } }).select('wamid status statusErrors').lean()
    : []
  const byWamid = new Map(messages.map(m => [m.wamid, m]))
  const bySession = new Map(reminders.map(r => [String(r.sessionId), r]))
  const byKey = new Map(reminders.map(r => [r.dedupeKey, r]))
  return (s) => {
    const win = classWindow(s)
    const r = bySession.get(String(s._id)) || (win ? byKey.get(dedupeKeyOf(s, win)) : null) || null
    return { reminder: r, delivery: r?.wamid ? byWamid.get(r.wamid) : null }
  }
}

// ── Tutor: GET /portal/class-reminders?sessionIds=a,b,c ─────────────────────
export async function getReminderState(req, res) {
  try {
    const ids = String(req.query.sessionIds || '')
      .split(',').map(s => s.trim()).filter(id => mongoose.isValidObjectId(id)).slice(0, MAX_SESSION_IDS)
    const now = Date.now()
    const tutorId = await callerTutorId(req)
    const avail = await reminderAvailability()
    const out = {
      serverNow: now,
      available: avail.ok && !!tutorId,
      reason: !tutorId ? 'no_tutor_profile' : (avail.ok ? '' : avail.reason),
      sessions: {},
    }
    if (!tutorId || !ids.length) return res.json(out)

    // Only the caller's own classes come back; anyone else's are simply absent
    const sessions = await ClassSession.find({ _id: { $in: ids }, tutorId })
      .select('studentId tutorId date scheduledStart scheduledEnd status')
      .populate('studentId', STUDENT_FIELDS)
      .lean()
    const lookup = await remindersFor(sessions)
    for (const s of sessions) {
      const { reminder, delivery } = lookup(s)
      out.sessions[s._id] = tutorView(s, reminder, delivery, now)
    }
    res.json(out)
  } catch (err) {
    console.error('Class reminder state error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ── Template parameters ─────────────────────────────────────────────────────
function linkBase() {
  return (process.env.FRONTEND_URL || 'https://hidaya.online').trim().replace(/\/+$/, '')
}

// Meta refuses parameters with newlines, tabs or 4+ spaces in a row
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)

async function buildParams(settings, session, win) {
  const student = session.studentId
  const tz = safeZone(student.timezone || 'Asia/Karachi')
  const start = new Date(win.opensAt)
  const needs = new Set(settings.params)

  const values = {
    student_first_name: String(student.name || '').trim().split(/\s+/)[0],
    student_name: student.name,
    class_time: new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(start),
    class_date: new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(start),
    academy_name: ACADEMY_NAME,
  }
  if (needs.has('course')) {
    const track = session.slotId?.tracks?.[0] || session.slotId?.track
    values.course = TRACK_LABEL[track] || 'Quran'
  }
  if (needs.has('tutor_name')) {
    const tutor = await TutorProfile.findById(session.tutorId).select('name').lean()
    values.tutor_name = tutor?.name || ''
  }
  if (needs.has('class_link')) {
    const page = await StudentClassLink.findOne({ student: student._id, isActive: true }).select('token').lean()
    values.class_link = page?.token ? `${linkBase()}/my-class/${page.token}` : (session.slotId?.meetLink || '')
  }

  const params = []
  for (const field of settings.params) {
    const v = clean(values[field])
    if (!v) {
      return { error: `The reminder template needs the ${FIELD_LABEL[field]?.toLowerCase() || field}, and this student has none on file. Ask the office to add it.` }
    }
    params.push(v)
  }
  const text = (settings.bodyText || '').replace(/\{\{(\d+)\}\}/g, (m, n) => params[Number(n) - 1] ?? m)
  return { params, text: text || params.join(' · ') }
}

// ── Meta's refusals, in words a tutor can act on ───────────────────────────
const TEMPLATE_PROBLEM = 'The reminder template has a problem in WhatsApp. Ask the admin to check WhatsApp → Class reminders.'
const GRAPH_MESSAGES = {
  190: 'The WhatsApp connection has expired. Ask the admin to reconnect it on the WhatsApp page.',
  368: "The academy's WhatsApp account is temporarily restricted by Meta.",
  131030: "This parent's number isn't on the WhatsApp test number's allowed list.",
  131031: "The academy's WhatsApp account is locked by Meta.",
  131056: 'Too many messages to this number just now. Try again in a minute.',
  130429: 'WhatsApp is busy right now. Try again in a minute.',
  133010: "The academy's WhatsApp number isn't registered with Meta.",
  132000: TEMPLATE_PROBLEM,
  132001: TEMPLATE_PROBLEM,
  132005: TEMPLATE_PROBLEM,
  132007: TEMPLATE_PROBLEM,
  132012: TEMPLATE_PROBLEM,
  132015: TEMPLATE_PROBLEM,
  132016: TEMPLATE_PROBLEM,
}
export const friendlyGraphError = (err) => GRAPH_MESSAGES[err.code] || `WhatsApp refused the reminder: ${err.message}`

// ── Tutor: POST /portal/class-reminders/:sessionId ──────────────────────────
export async function sendClassReminder(req, res) {
  const { sessionId } = req.params
  if (!mongoose.isValidObjectId(sessionId)) return res.status(400).json({ error: 'Invalid class' })

  let claimId = null
  try {
    const tutorId = await callerTutorId(req)
    if (!tutorId) return res.status(403).json({ error: "Only a class's own tutor can send its reminder" })

    const session = await ClassSession.findById(sessionId)
      .populate('studentId', STUDENT_FIELDS)
      .populate('slotId', 'track tracks meetLink')
      .lean()
    if (!session) return res.status(404).json({ error: 'Class not found' })
    if (String(session.tutorId) !== String(tutorId)) {
      return res.status(403).json({ error: "This isn't your class, so you can't send its reminder" })
    }

    const avail = await reminderAvailability()
    if (!avail.ok) return res.status(503).json({ error: UNAVAILABLE_MESSAGE[avail.reason], reason: avail.reason })

    const now = Date.now()
    const lookup = await remindersFor([session])
    const { reminder: existing, delivery } = lookup(session)
    if (existing && !isStale(existing, now)) {
      return res.status(409).json({
        error: existing.status === 'sending' ? 'This reminder is being sent right now.' : 'A reminder has already been sent for this class.',
        reminder: tutorView(session, existing, delivery, now),
      })
    }

    const { block, win, recipient } = assess(session, now)
    if (block) {
      return res.status(409).json({
        error: BLOCK_MESSAGE[block], block, reminder: tutorView(session, null, null, now),
      })
    }

    const built = await buildParams(avail.settings, session, win)
    if (built.error) return res.status(422).json({ error: built.error })

    // Claim the class before talking to Meta — the unique indexes make a second
    // tap (another tab, a double click) fail here instead of sending twice.
    if (existing) await ClassReminder.deleteOne({ _id: existing._id, status: 'sending', claimedAt: existing.claimedAt })
    try {
      const claim = await ClassReminder.create({
        sessionId: session._id,
        studentId: session.studentId._id,
        tutorId,
        sentBy: req.userId,
        dedupeKey: dedupeKeyOf(session, win),
        classStartAt: new Date(win.opensAt),
        recipientType: recipient.type,
        recipientLabel: recipient.label,
        waId: recipient.waId,
        templateName: avail.settings.templateName,
      })
      claimId = claim._id
    } catch (err) {
      if (err?.code === 11000) return res.status(409).json({ error: 'A reminder has already been sent for this class.' })
      throw err
    }

    const payload = {
      to: recipient.waId,
      type: 'template',
      template: {
        name: avail.settings.templateName,
        language: { code: avail.settings.language || 'en_US' },
        ...(built.params.length
          ? { components: [{ type: 'body', parameters: built.params.map(text => ({ type: 'text', text })) }] }
          : {}),
      },
    }

    let wamid
    try {
      wamid = await sendMessage(avail.sender.phoneNumberId, avail.sender.token, payload)
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        // Meta may or may not have sent it. Keep the claim: it goes stale in two
        // minutes, after which the tutor can try again.
        claimId = null
        return res.status(504).json({ error: "WhatsApp didn't answer in time. If the family doesn't receive it, you can try again in two minutes." })
      }
      await ClassReminder.deleteOne({ _id: claimId })
      claimId = null
      if (err instanceof GraphError) {
        await logActivity({
          level: 'warning', category: 'portal', action: 'class_reminder_failed',
          message: `Class reminder for ${session.studentId.name} refused by Meta (${err.code ?? '?'}): ${err.message}`, req,
          meta: { sessionId: session._id, code: err.code },
        })
        return res.status(502).json({ error: friendlyGraphError(err), code: err.code })
      }
      throw err
    }

    const sentAt = new Date()
    await ClassReminder.updateOne({ _id: claimId }, { $set: { status: 'sent', sentAt, wamid } })
    const reminder = { _id: claimId, status: 'sent', sentAt, recipientLabel: recipient.label, wamid }
    claimId = null // it went out: from here on, nothing may release the claim

    // The message log (WhatsApp page). A failure here must not undo the reminder.
    try {
      const saved = await WhatsappMessage.create({
        wamid, direction: 'out', source: 'live', waId: recipient.waId, phoneNumberId: avail.sender.phoneNumberId,
        type: 'template', text: built.text, templateName: avail.settings.templateName,
        status: 'accepted', timestamp: sentAt, sentBy: req.userId, studentId: session.studentId._id,
      })
      const event = { _id: saved._id, wamid, direction: 'out', source: 'live', waId: recipient.waId, type: 'template', text: saved.text, timestamp: sentAt, studentId: saved.studentId }
      for (const role of ['super_admin', 'admin']) emitToRole(role, 'whatsapp_message', event)
    } catch (err) {
      console.error('Class reminder: message log write failed:', err)
    }
    for (const role of ['super_admin', 'admin']) emitToRole(role, 'class_reminder_sent', { sessionId: session._id })

    await logActivity({
      level: 'info', category: 'portal', action: 'class_reminder_sent',
      message: `WhatsApp class reminder sent for ${session.studentId.name} (${recipient.label})`, req,
      meta: { sessionId: session._id, studentId: session.studentId._id, wamid },
    })
    res.status(201).json({ reminder: tutorView(session, reminder, null, Date.now()) })
  } catch (err) {
    if (claimId) await ClassReminder.deleteOne({ _id: claimId }).catch(() => {})
    console.error('Send class reminder error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Admin — /portal/whatsapp/reminders/* (whatsapp.manage)
// ════════════════════════════════════════════════════════════════════════════

function settingsView(s) {
  return {
    enabled: !!s?.enabled,
    templateName: s?.templateName || '',
    language: s?.language || 'en_US',
    params: s?.params || [],
    bodyText: s?.bodyText || '',
    updatedAt: s?.updatedAt || null,
  }
}

export async function getReminderSettings(_req, res) {
  try {
    const settings = await WhatsappReminderSettings.findOne({ key: 'default' }).lean()
    res.json({ settings: settingsView(settings), fields: FIELD_CATALOG, recommended: RECOMMENDED_TEMPLATE })
  } catch (err) {
    console.error('Get reminder settings error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/*
 * The template must be sendable with body parameters alone: a media or
 * variable header, or a button with a variable URL, needs values this feature
 * doesn't have — Meta would refuse every reminder.
 */
function templateProblem(tpl) {
  for (const c of tpl.components || []) {
    if (c.type === 'HEADER' && (c.format && c.format !== 'TEXT')) return 'its header is a photo, video or document'
    if (c.type === 'HEADER' && /\{\{/.test(c.text || '')) return 'its header has a variable'
    if (c.type === 'BUTTONS' && (c.buttons || []).some(b => /\{\{/.test(b.url || ''))) return 'a button has a variable link'
    if (c.type === 'BUTTONS' && (c.buttons || []).some(b => ['OTP', 'COPY_CODE', 'FLOW', 'CATALOG', 'MPM'].includes(b.type))) return 'it has a button type reminders cannot fill'
  }
  return ''
}

const bodyOf = (tpl) => (tpl.components || []).find(c => c.type === 'BODY')?.text || ''
const varCount = (text) => {
  const nums = [...String(text).matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]))
  return nums.length ? Math.max(...nums) : 0
}

export async function updateReminderSettings(req, res) {
  const { enabled, templateName = '', language = 'en_US', params = [] } = req.body || {}
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' })
  if (typeof templateName !== 'string' || (templateName && !/^[a-z0-9_]{1,512}$/.test(templateName))) {
    return res.status(400).json({ error: 'Pick a template' })
  }
  if (typeof language !== 'string' || !/^[A-Za-z_]{2,10}$/.test(language)) return res.status(400).json({ error: 'Invalid language' })
  if (!Array.isArray(params) || params.some(p => !REMINDER_FIELDS.includes(p))) {
    return res.status(400).json({ error: 'Choose what fills each variable' })
  }
  if (enabled && !templateName) return res.status(400).json({ error: 'Choose a reminder template before switching reminders on' })

  try {
    const current = await WhatsappReminderSettings.findOne({ key: 'default' }).lean()
    const update = { enabled, templateName, language, params, updatedBy: req.userId }

    const templateChanged = templateName !== (current?.templateName || '') || language !== (current?.language || 'en_US')
      || params.join(',') !== (current?.params || []).join(',')
    if (templateName && (enabled || templateChanged)) {
      const sender = await resolveSender()
      if (!sender) return res.status(503).json({ error: 'Connect the WhatsApp number first — templates live on its account' })
      const templates = await listTemplates(sender.wabaId, sender.token)
      const tpl = templates.find(t => t.name === templateName && t.language === language)
      if (!tpl) return res.status(400).json({ error: `No template "${templateName}" (${language}) on the WhatsApp account` })
      const problem = templateProblem(tpl)
      if (problem) return res.status(400).json({ error: `That template can't be used for reminders: ${problem}` })
      const body = bodyOf(tpl)
      const needed = varCount(body)
      if (params.length !== needed) {
        return res.status(400).json({ error: `The template has ${needed} variable(s); choose what fills each one` })
      }
      if (enabled && tpl.status !== 'APPROVED') {
        return res.status(400).json({ error: `Meta hasn't approved "${templateName}" yet (status: ${tpl.status}). Reminders can be switched on once it is approved.` })
      }
      update.bodyText = body
    } else if (!templateName) {
      update.bodyText = ''
      update.params = []
    }

    const saved = await WhatsappReminderSettings.findOneAndUpdate(
      { key: 'default' }, { $set: update }, { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean()
    await logActivity({
      level: 'info', category: 'portal', action: 'class_reminder_settings',
      message: `WhatsApp class reminders ${enabled ? 'on' : 'off'}${templateName ? ` · template ${templateName}` : ''}`, req,
    })
    res.json({ settings: settingsView(saved) })
  } catch (err) {
    if (err instanceof GraphError) return res.status(502).json({ error: err.message })
    console.error('Update reminder settings error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// POST /portal/whatsapp/reminders/template — submit the recommended template to Meta
export async function createRecommendedTemplate(req, res) {
  try {
    const sender = await resolveSender()
    if (!sender) return res.status(503).json({ error: 'Connect the WhatsApp number first — templates live on its account' })
    const t = RECOMMENDED_TEMPLATE
    const examples = t.params.map(p => FIELD_CATALOG.find(f => f.key === p).example)
    const created = await createTemplate(sender.wabaId, sender.token, {
      name: t.name, category: t.category, language: t.language,
      components: [{ type: 'BODY', text: t.body, example: { body_text: [examples] } }],
    })
    await logActivity({ level: 'info', category: 'portal', action: 'whatsapp_template_created', message: `WhatsApp template ${t.name} submitted (class reminders)`, req })
    res.status(201).json({ template: { id: created.id, name: t.name, language: t.language, status: created.status || 'PENDING', category: created.category || t.category } })
  } catch (err) {
    if (err instanceof GraphError) return res.status(502).json({ error: err.message })
    console.error('Create reminder template error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ── Who may send ────────────────────────────────────────────────────────────
async function tutorRoleIds() {
  return (await Role.find({ key: 'tutor' }).select('_id').lean()).map(r => r._id)
}

// GET /portal/whatsapp/reminders/access — every tutor account, and anyone else holding the grant
export async function listReminderAccess(_req, res) {
  try {
    const [roleIds, profileUserIds] = await Promise.all([tutorRoleIds(), TutorProfile.distinct('userId')])
    const users = await User.find({
      $or: [
        { linkedTutorId: { $ne: null } },
        { _id: { $in: profileUserIds } },
        { roles: { $in: roleIds } },
        { extraPermissions: REMINDER_PERM },
      ],
    })
      .select('displayName email status roles linkedTutorId linkedStudentId extraPermissions')
      .populate('roles', 'key name permissions')
      .populate('linkedTutorId', 'name tutorId status')
      .lean()

    const rows = []
    for (const u of users) {
      if (isStudentAccount({ user: u })) continue
      const viaRole = (u.roles || []).some(r => (r.permissions || []).includes(REMINDER_PERM))
      rows.push({
        _id: u._id,
        displayName: u.displayName,
        email: u.email,
        status: u.status,
        tutor: u.linkedTutorId ? { name: u.linkedTutorId.name, tutorId: u.linkedTutorId.tutorId, status: u.linkedTutorId.status } : null,
        roles: (u.roles || []).map(r => r.name || r.key),
        granted: (u.extraPermissions || []).includes(REMINDER_PERM),
        viaRole,
      })
    }
    rows.sort((a, b) => (a.tutor?.name || a.displayName).localeCompare(b.tutor?.name || b.displayName))
    res.json({ users: rows })
  } catch (err) {
    console.error('List reminder access error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// PUT /portal/whatsapp/reminders/access — { userIds: [...], allowed: bool }
export async function setReminderAccess(req, res) {
  const { userIds, allowed } = req.body || {}
  if (typeof allowed !== 'boolean') return res.status(400).json({ error: 'allowed must be true or false' })
  if (!Array.isArray(userIds) || !userIds.length || userIds.length > 500 || !userIds.every(id => mongoose.isValidObjectId(id))) {
    return res.status(400).json({ error: 'Choose at least one person' })
  }
  try {
    const users = await User.find({ _id: { $in: userIds } })
      .select('displayName linkedTutorId linkedStudentId roles extraPermissions')
      .populate('roles', 'key')
      .lean()
    const skipped = []
    const targets = []
    for (const u of users) {
      // A grant only means something to someone who has classes of their own.
      // Revoking is always allowed, so a stray grant can be cleaned up.
      if (allowed) {
        if (isStudentAccount({ user: u })) {
          skipped.push({ _id: u._id, displayName: u.displayName, reason: 'Student account' })
          continue
        }
        if (!u.linkedTutorId && !(await TutorProfile.exists({ userId: u._id }))) {
          skipped.push({ _id: u._id, displayName: u.displayName, reason: 'Not linked to a tutor profile' })
          continue
        }
      }
      targets.push(u)
    }
    const ids = targets.map(u => u._id)
    if (ids.length) {
      await User.updateMany(
        { _id: { $in: ids } },
        allowed ? { $addToSet: { extraPermissions: REMINDER_PERM } } : { $pull: { extraPermissions: REMINDER_PERM } },
      )
      // Their open portal tabs re-read /me so the button appears or disappears now
      for (const id of ids) emitToUser(String(id), 'permissions_changed', { permission: REMINDER_PERM, allowed })
      await logActivity({
        level: 'info', category: 'portal', action: allowed ? 'class_reminder_access_granted' : 'class_reminder_access_revoked',
        message: `WhatsApp reminders ${allowed ? 'allowed for' : 'removed from'} ${targets.map(u => u.displayName).join(', ')}`, req,
        meta: { userIds: ids },
      })
    }
    res.json({ updated: ids.length, skipped })
  } catch (err) {
    console.error('Set reminder access error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ── The log ─────────────────────────────────────────────────────────────────
// GET /portal/whatsapp/reminders?page=&limit=
export async function listReminders(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100)
    const page = Math.max(Number(req.query.page) || 1, 1)
    const filter = { status: 'sent' }
    const since = new Date(Date.now() - 24 * 60 * 60_000)

    const [rows, total, recent] = await Promise.all([
      ClassReminder.find(filter).sort({ sentAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('studentId', 'name rollNo')
        .populate('tutorId', 'name tutorId')
        .populate('sentBy', 'displayName')
        .lean(),
      ClassReminder.countDocuments(filter),
      ClassReminder.find({ ...filter, sentAt: { $gte: since } }).select('wamid').lean(),
    ])
    const wamids = [...new Set([...rows, ...recent].map(r => r.wamid).filter(Boolean))]
    const msgs = await WhatsappMessage.find({ wamid: { $in: wamids } }).select('wamid status statusErrors').lean()
    const byWamid = new Map(msgs.map(m => [m.wamid, m]))

    const stats = { sent: recent.length, delivered: 0, read: 0, failed: 0 }
    for (const r of recent) {
      const st = byWamid.get(r.wamid)?.status
      if (st === 'delivered') stats.delivered++
      else if (st === 'read') { stats.delivered++; stats.read++ }
      else if (st === 'failed') stats.failed++
    }

    res.json({
      reminders: rows.map(r => {
        const m = byWamid.get(r.wamid)
        return {
          _id: r._id,
          sentAt: r.sentAt,
          classStartAt: r.classStartAt,
          student: r.studentId ? { _id: r.studentId._id, name: r.studentId.name, rollNo: r.studentId.rollNo } : null,
          tutor: r.tutorId ? { name: r.tutorId.name, tutorId: r.tutorId.tutorId } : null,
          sentBy: r.sentBy?.displayName || '',
          recipientLabel: r.recipientLabel,
          waId: r.waId,
          templateName: r.templateName,
          delivery: m?.status || 'accepted',
          failedReason: m?.status === 'failed' ? (m.statusErrors?.[0]?.title || 'Not delivered') : '',
        }
      }),
      total, page, pages: Math.max(Math.ceil(total / limit), 1), stats,
    })
  } catch (err) {
    console.error('List class reminders error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Smoke test for WhatsApp class reminders
// (controllers/portalClassReminderController.js).
//
// Covers:
//   - per-user permission: User.extraPermissions grants whatsapp.reminder on
//     top of the roles, and nothing outside USER_GRANTABLE_PERMISSIONS
//   - settings: template must exist, match its variables, be APPROVED to switch on
//   - the window: closed before the class starts, open during it, closed after
//     its end or once completed / missed
//   - only the class's own tutor; a student on leave is never reminded
//   - recipient: flagged guardian first, local Pakistani numbers converted,
//     unusable numbers refused; the tutor never receives the number
//   - once per class: a second tap, a regenerated session and two simultaneous
//     taps all send exactly one message
//   - a Meta refusal releases the class for a retry; a timeout holds it until
//     the claim goes stale
//   - delivery ticks from the webhook reach the tutor's view
//   - the access list and per-person grants / revokes
//
// Meta is a stubbed global fetch. Runs against a THROWAWAY database
// (hidaya_class_reminder_smoke) and drops it. No server or Meta account needed.
// Run: node scripts/smoke-class-reminders.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import User from '../models/User.js'
import Role from '../models/Role.js'
import Student from '../models/Student.js'
import TutorProfile from '../models/TutorProfile.js'
import ClassSession from '../models/ClassSession.js'
import ClassReminder from '../models/ClassReminder.js'
import WhatsappMessage from '../models/WhatsappMessage.js'
import WhatsappReminderSettings from '../models/WhatsappReminderSettings.js'
import '../models/ClassSlot.js'
import '../models/StudentClassLink.js'
import { effectivePermissions } from '../middleware/portalAuth.js'
import {
  getReminderState, sendClassReminder, updateReminderSettings, listReminderAccess, setReminderAccess, listReminders,
} from '../controllers/portalClassReminderController.js'
import { processWebhookPayload } from '../controllers/whatsappWebhookController.js'
import { DEFAULT_ROLE_PERMISSIONS } from '../config/permissions.js'

process.env.WHATSAPP_ACCESS_TOKEN = 'TEST_TOKEN'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'PN_TEST'
process.env.WHATSAPP_WABA_ID = 'WABA_TEST'
if (!process.env.MFA_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY.length !== 64) {
  process.env.MFA_ENCRYPTION_KEY = 'a'.repeat(64)
}

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }

// ── Fake Graph API ──────────────────────────────────────────────────────────
const sends = []
let sentSeq = 0
let mode = 'ok' // ok | template_error | timeout | slow
let templateStatus = 'APPROVED'
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = init.method || 'GET'
  const path = url.pathname.replace(/^\/v[\d.]+\//, '')
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

  if (path === 'WABA_TEST/message_templates' && method === 'GET') {
    return json(200, {
      data: [
        { name: 'class_reminder', language: 'en_US', status: templateStatus, category: 'UTILITY', components: [{ type: 'BODY', text: "Assalamu alaikum! {{1}}'s class is due at {{2}} today." }] },
        { name: 'with_media', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi {{1}}' }] },
      ],
    })
  }
  if (path === 'PN_TEST/messages') {
    if (mode === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    if (mode === 'template_error') return json(400, { error: { message: 'Template name does not exist in the translation', code: 132001 } })
    if (mode === 'slow') await new Promise(r => setTimeout(r, 150))
    sends.push(JSON.parse(init.body))
    return json(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.R_${++sentSeq}` }] })
  }
  return json(404, { error: { message: `unstubbed ${method} ${path}` } })
}

const SMOKE_DB = 'hidaya_class_reminder_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
await mongoose.connection.dropDatabase()
await Promise.all([ClassReminder.syncIndexes(), WhatsappMessage.syncIndexes(), User.syncIndexes()])

const call = async (handler, req) => {
  let status = 200, out
  const res = { status(c) { status = c; return this }, json(b) { out = b; return this } }
  await handler({ method: 'POST', path: '/', headers: {}, query: {}, params: {}, body: {}, ...req }, res)
  return { status, body: out }
}

// PKT wall clock helpers: a session starting `offsetMin` from now
const PKT = 5 * 60
function sessionAt(offsetMin, durationMin = 30) {
  const startAbs = Date.now() + offsetMin * 60_000
  const pkt = new Date(startAbs + PKT * 60_000)
  const day = pkt.toISOString().slice(0, 10)
  const hhmm = (d) => d.toISOString().slice(11, 16)
  return { date: new Date(`${day}T00:00:00Z`), scheduledStart: hhmm(pkt), scheduledEnd: hhmm(new Date(pkt.getTime() + durationMin * 60_000)) }
}

try {
  // ── Fixtures ──────────────────────────────────────────────────────────────
  const roles = {}
  for (const key of ['super_admin', 'tutor']) {
    roles[key] = await Role.create({ key, name: key, permissions: DEFAULT_ROLE_PERMISSIONS[key], system: true })
  }
  const mkUser = (email, extra = {}) => User.create({ email, password: 'secret123', displayName: email.split('@')[0], roles: [roles.tutor._id], ...extra })
  const tutorUser = await mkUser('tutor.a@x.test')
  const otherUser = await mkUser('tutor.b@x.test')
  const noProfileUser = await mkUser('helper@x.test')
  const tutorA = await TutorProfile.create({ tutorId: 'T01', userId: tutorUser._id, name: 'Bilal Ahmed' })
  const tutorB = await TutorProfile.create({ tutorId: 'T02', userId: otherUser._id, name: 'Usman Ali' })
  await User.updateOne({ _id: tutorUser._id }, { linkedTutorId: tutorA._id })
  await User.updateOne({ _id: otherUser._id }, { linkedTutorId: tutorB._id })
  const admin = await User.create({ email: 'admin@x.test', password: 'secret123', displayName: 'Admin', roles: [roles.super_admin._id] })

  const hamza = await Student.create({
    name: 'Hamza Raza', rollNo: 'HID518', status: 'active', country: 'United Kingdom', timezone: 'Europe/London',
    whatsappNumber: '+44 7700 900123',
    guardians: [{ relation: 'mother', name: 'Sara', phone: '+44 7700 900999', isWhatsappRecipient: true }],
  })
  const aisha = await Student.create({ name: 'Aisha Khan', rollNo: 'HID600', status: 'active', country: 'Pakistan', whatsappNumber: '0300-1234567' })
  const noNumber = await Student.create({ name: 'Zainab Malik', rollNo: 'HID601', status: 'active' })
  const ukLocal = await Student.create({ name: 'Yusuf Shah', rollNo: 'HID602', status: 'active', country: 'United Kingdom', timezone: 'Europe/London', phone: '07700 900555' })
  const onLeave = await Student.create({ name: 'Maryam Noor', rollNo: 'HID603', status: 'leave', whatsappNumber: '+923001112222' })

  const loadReq = async (userId) => {
    const user = await User.findById(userId).populate('roles').lean()
    return { user, userId: user._id, userPermissions: effectivePermissions(user) }
  }

  // ── Permission ────────────────────────────────────────────────────────────
  console.log('\nPer-user permission')
  let req = await loadReq(tutorUser._id)
  ok(!req.userPermissions.has('whatsapp.reminder'), 'the tutor role alone does not grant reminders')
  await User.updateOne({ _id: tutorUser._id }, { $addToSet: { extraPermissions: 'whatsapp.reminder' } })
  req = await loadReq(tutorUser._id)
  ok(req.userPermissions.has('whatsapp.reminder'), 'extraPermissions grants it to that one person')
  ok(!(await loadReq(otherUser._id)).userPermissions.has('whatsapp.reminder'), 'another tutor is unaffected')
  await User.collection.updateOne({ _id: otherUser._id }, { $set: { extraPermissions: ['data.export'] } })
  ok(!(await loadReq(otherUser._id)).userPermissions.has('data.export'), 'a non-grantable value written to the DB grants nothing')
  let verr = null
  try { await new User({ email: 'z@x.test', password: 'secret123', displayName: 'z', roles: [roles.tutor._id], extraPermissions: ['user.delete'] }).validate() } catch (e) { verr = e }
  ok(verr?.errors?.extraPermissions, 'the model refuses a non-grantable extra permission')
  await User.collection.updateOne({ _id: otherUser._id }, { $set: { extraPermissions: [] } })

  // ── Settings ──────────────────────────────────────────────────────────────
  console.log('\nSettings')
  const adminReq = await loadReq(admin._id)
  let r = await call(updateReminderSettings, { ...adminReq, body: { enabled: true, templateName: 'nope', params: [] } })
  ok(r.status === 400 && /No template/.test(r.body.error), 'unknown template refused')
  r = await call(updateReminderSettings, { ...adminReq, body: { enabled: false, templateName: 'with_media', params: ['student_name'] } })
  ok(r.status === 400 && /header/.test(r.body.error), 'template with a media header refused')
  r = await call(updateReminderSettings, { ...adminReq, body: { enabled: true, templateName: 'class_reminder', params: ['student_first_name'] } })
  ok(r.status === 400 && /2 variable/.test(r.body.error), 'variable count must match')
  templateStatus = 'PENDING'
  r = await call(updateReminderSettings, { ...adminReq, body: { enabled: true, templateName: 'class_reminder', params: ['student_first_name', 'class_time'] } })
  ok(r.status === 400 && /approved/.test(r.body.error), 'cannot switch on while Meta has not approved the template')
  r = await call(updateReminderSettings, { ...adminReq, body: { enabled: false, templateName: 'class_reminder', params: ['student_first_name', 'class_time'] } })
  ok(r.status === 200 && !r.body.settings.enabled, 'a pending template can be saved with reminders off')

  // Reminders off → tutor sees unavailable, send refused
  const live = await ClassSession.create({ studentId: hamza._id, tutorId: tutorA._id, ...sessionAt(-5), status: 'started' })
  r = await call(getReminderState, { ...req, query: { sessionIds: String(live._id) } })
  ok(r.body.available === false && r.body.reason === 'disabled', 'state reports reminders switched off')
  r = await call(sendClassReminder, { ...req, params: { sessionId: String(live._id) } })
  ok(r.status === 503 && sends.length === 0, 'send refused while off')

  templateStatus = 'APPROVED'
  r = await call(updateReminderSettings, { ...adminReq, body: { enabled: true, templateName: 'class_reminder', params: ['student_first_name', 'class_time'] } })
  ok(r.status === 200 && r.body.settings.enabled && /\{\{1\}\}/.test(r.body.settings.bodyText), 'switched on with the approved template')

  // ── Window + ownership ────────────────────────────────────────────────────
  console.log('\nWindow and ownership')
  const later = await ClassSession.create({ studentId: aisha._id, tutorId: tutorA._id, ...sessionAt(20) })
  const finished = await ClassSession.create({ studentId: aisha._id, tutorId: tutorA._id, ...sessionAt(-60, 30) })
  const completed = await ClassSession.create({ studentId: noNumber._id, tutorId: tutorA._id, ...sessionAt(-5), status: 'completed' })
  const others = await ClassSession.create({ studentId: aisha._id, tutorId: tutorB._id, ...sessionAt(-2) })

  r = await call(getReminderState, { ...req, query: { sessionIds: [live, later, finished, completed, others].map(s => s._id).join(',') } })
  const st = r.body.sessions
  ok(r.body.available && typeof r.body.serverNow === 'number', 'available, with the server clock')
  ok(st[live._id]?.canSend && st[live._id].recipient === 'Mother', 'a class in progress can be reminded (to the flagged guardian)')
  ok(!st[later._id].canSend && st[later._id].block === 'not_yet' && st[later._id].opensAt > Date.now(), 'a class not yet started: not yet, with its opening time')
  ok(st[finished._id].block === 'class_over', 'a class past its end time is over')
  ok(st[completed._id].block === 'class_over', 'a completed class is over')
  ok(!(String(others._id) in st), "another tutor's class is not returned at all")
  ok(!JSON.stringify(r.body).includes('7700') && !JSON.stringify(r.body).includes('waId'), 'no phone number reaches the tutor')

  r = await call(sendClassReminder, { ...req, params: { sessionId: String(later._id) } })
  ok(r.status === 409 && r.body.block === 'not_yet', 'send before the class time is refused')
  r = await call(sendClassReminder, { ...req, params: { sessionId: String(others._id) } })
  ok(r.status === 403, "send for another tutor's class is refused")
  r = await call(sendClassReminder, { ...req, params: { sessionId: String(finished._id) } })
  ok(r.status === 409 && r.body.block === 'class_over', 'send after the class is refused')
  ok(sends.length === 0, 'nothing reached Meta')

  // ── Numbers ───────────────────────────────────────────────────────────────
  console.log('\nRecipients')
  const sNo = await ClassSession.create({ studentId: noNumber._id, tutorId: tutorA._id, ...sessionAt(-1) })
  const sUk = await ClassSession.create({ studentId: ukLocal._id, tutorId: tutorA._id, ...sessionAt(-1) })
  const sLeave = await ClassSession.create({ studentId: onLeave._id, tutorId: tutorA._id, ...sessionAt(-1) })
  r = await call(getReminderState, { ...req, query: { sessionIds: [sNo, sUk, sLeave].map(s => s._id).join(',') } })
  ok(r.body.sessions[sNo._id].block === 'no_number', 'no number on file')
  ok(r.body.sessions[sUk._id].block === 'invalid_number', 'a UK local number is not guessed')
  ok(r.body.sessions[sLeave._id].block === 'student_inactive', 'a student on leave is not reminded')

  // ── Send ──────────────────────────────────────────────────────────────────
  console.log('\nSend')
  r = await call(sendClassReminder, { ...req, params: { sessionId: String(live._id) } })
  ok(r.status === 201 && r.body.reminder.state === 'sent' && r.body.reminder.recipient === 'Mother', 'sent')
  ok(!JSON.stringify(r.body).includes('447700'), 'the response carries no number')
  const sent = sends.at(-1)
  ok(sent?.to === '447700900999' && sent.template.name === 'class_reminder', 'went to the flagged guardian with the chosen template')
  const params = sent.template.components[0].parameters.map(p => p.text)
  const liveStart = Date.parse(`${live.date.toISOString().slice(0, 10)}T${live.scheduledStart}:00Z`) - PKT * 60_000
  const ukTime = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/London', hour: 'numeric', minute: '2-digit', hour12: true }).format(liveStart)
  ok(params[0] === 'Hamza' && params[1] === ukTime, `parameters: first name + class time in the student's zone (${params.join(' / ')})`)
  const msg = await WhatsappMessage.findOne({ wamid: sent && `wamid.R_${sentSeq}` }).lean()
  ok(msg && String(msg.studentId) === String(hamza._id) && String(msg.sentBy) === String(tutorUser._id) && msg.text.includes('Hamza'), 'logged on the WhatsApp page with the rendered text')

  r = await call(sendClassReminder, { ...req, params: { sessionId: String(live._id) } })
  ok(r.status === 409 && /already/.test(r.body.error), 'a second tap is refused')
  const regenerated = await ClassSession.create({ studentId: hamza._id, tutorId: tutorA._id, date: live.date, scheduledStart: live.scheduledStart, scheduledEnd: live.scheduledEnd })
  r = await call(sendClassReminder, { ...req, params: { sessionId: String(regenerated._id) } })
  ok(r.status === 409, 'a regenerated session of the same class is refused')
  r = await call(getReminderState, { ...req, query: { sessionIds: String(regenerated._id) } })
  ok(r.body.sessions[regenerated._id].state === 'sent', 'and shows as already reminded')

  console.log('\nPakistani local number + simultaneous taps')
  const pk = await ClassSession.create({ studentId: aisha._id, tutorId: tutorA._id, ...sessionAt(-3) })
  const before = sends.length
  mode = 'slow'
  const [a, b] = await Promise.all([
    call(sendClassReminder, { ...req, params: { sessionId: String(pk._id) } }),
    call(sendClassReminder, { ...req, params: { sessionId: String(pk._id) } }),
  ])
  mode = 'ok'
  ok([a.status, b.status].sort().join(',') === '201,409', 'two simultaneous taps: one sent, one refused')
  ok(sends.length === before + 1 && sends.at(-1).to === '923001234567', 'exactly one message, to 0300-1234567 as +92 300 1234567')

  // ── Failures ──────────────────────────────────────────────────────────────
  console.log('\nMeta refusal and timeout')
  const s3 = await ClassSession.create({ studentId: hamza._id, tutorId: tutorA._id, ...sessionAt(-4, 60) })
  mode = 'template_error'
  r = await call(sendClassReminder, { ...req, params: { sessionId: String(s3._id) } })
  ok(r.status === 502 && /template/.test(r.body.error) && r.body.code === 132001, 'template error explained')
  ok(!(await ClassReminder.exists({ sessionId: s3._id })), 'the class is released for a retry')
  mode = 'ok'
  r = await call(sendClassReminder, { ...req, params: { sessionId: String(s3._id) } })
  ok(r.status === 201, 'retry after the fix is sent')

  const s4 = await ClassSession.create({ studentId: aisha._id, tutorId: tutorA._id, ...sessionAt(-6, 60) })
  mode = 'timeout'
  r = await call(sendClassReminder, { ...req, params: { sessionId: String(s4._id) } })
  ok(r.status === 504, 'timeout reported')
  mode = 'ok'
  r = await call(sendClassReminder, { ...req, params: { sessionId: String(s4._id) } })
  ok(r.status === 409 && /being sent/.test(r.body.error), 'outcome unknown: held while the claim is fresh')
  await ClassReminder.updateOne({ sessionId: s4._id }, { $set: { claimedAt: new Date(Date.now() - 3 * 60_000) } })
  r = await call(sendClassReminder, { ...req, params: { sessionId: String(s4._id) } })
  ok(r.status === 201 && (await ClassReminder.countDocuments({ sessionId: s4._id })) === 1, 'a stale claim is taken over')

  // ── Ticks ─────────────────────────────────────────────────────────────────
  console.log('\nDelivery ticks')
  const rem = await ClassReminder.findOne({ sessionId: live._id }).lean()
  const ts = Math.floor(Date.now() / 1000)
  await processWebhookPayload({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: rem.wamid, status: 'read', timestamp: ts }] } }] }] })
  r = await call(getReminderState, { ...req, query: { sessionIds: String(live._id) } })
  ok(r.body.sessions[live._id].delivery === 'read', 'read tick reaches the tutor view')
  await processWebhookPayload({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: rem.wamid, status: 'delivered', timestamp: ts }] } }] }] })
  r = await call(getReminderState, { ...req, query: { sessionIds: String(live._id) } })
  ok(r.body.sessions[live._id].delivery === 'read', 'a late "delivered" does not move it backwards')

  // ── Admin: log + access ───────────────────────────────────────────────────
  console.log('\nAdmin')
  r = await call(listReminders, { ...adminReq, query: {} })
  ok(r.body.total === 4 && r.body.stats.read === 1 && r.body.reminders[0].student?.name, 'reminder log with stats')

  r = await call(listReminderAccess, adminReq)
  const row = (id) => r.body.users.find(u => String(u._id) === String(id))
  ok(row(tutorUser._id)?.granted === true && row(otherUser._id)?.granted === false, 'access list shows who may send')
  ok(row(tutorUser._id)?.tutor?.tutorId === 'T01', 'with the tutor profile')
  ok(!r.body.users.some(u => String(u._id) === String(admin._id)), 'non-tutors without the grant are not listed')

  r = await call(setReminderAccess, { ...adminReq, body: { userIds: [String(otherUser._id), String(noProfileUser._id)], allowed: true } })
  ok(r.body.updated === 1 && r.body.skipped.length === 1 && /tutor profile/.test(r.body.skipped[0].reason), 'grant: a tutor yes, an account with no tutor profile skipped')
  ok((await loadReq(otherUser._id)).userPermissions.has('whatsapp.reminder'), 'the granted tutor now holds it')
  r = await call(setReminderAccess, { ...adminReq, body: { userIds: [String(tutorUser._id)], allowed: false } })
  ok(r.body.updated === 1 && !(await loadReq(tutorUser._id)).userPermissions.has('whatsapp.reminder'), 'revoked')
} catch (err) {
  fail++
  console.error(err)
} finally {
  await mongoose.connection.dropDatabase()
  await mongoose.disconnect()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

// Smoke test for the new features added in this change set:
//  - Night-shift board wrap (startHour>endHour): dayOffset tagging + next-day fetch
//  - Board student populate now carries status / performanceTags / freshness / leave
//  - Student feedback (admin + quality) with per-type permission gating + delete
//  - Paginated class history (getStudentClasses) with daily lessons joined in
//  - Student progress detail returns feedbacks + "taught" on recent classes
//  - Chat unread total
// Calls controllers directly with mocked req/res against the real DB, then cleans up.
// Run: node scripts/smoke-new-features.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import ClassSession from '../models/ClassSession.js'
import TutorProfile from '../models/TutorProfile.js'
import Student from '../models/Student.js'
import User from '../models/User.js'
import LessonEntry from '../models/LessonEntry.js'
import ChatThread from '../models/ChatThread.js'
import Message from '../models/Message.js'
import '../models/Role.js'
import '../models/Log.js'
import { getBoard } from '../controllers/portalScheduleController.js'
import { addStudentFeedback, deleteStudentFeedback } from '../controllers/portalStudentController.js'
import { getStudentClasses, getStudentProgressDetail } from '../controllers/portalStudentProgressController.js'
import { getUnreadTotal } from '../controllers/portalChatController.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }
function mockRes() {
  const res = { _status: 200, _json: null }
  res.status = (c) => { res._status = c; return res }
  res.json = (d) => { res._json = d; return res }
  return res
}

const DATE = '2099-04-06'           // isolated far-future day
const DATEP1 = '2099-04-07'         // the morning after
const noon = (d) => new Date(`${d}T12:00:00`)
const dayRange = (d) => {
  const s = new Date(d); s.setHours(0, 0, 0, 0)
  const e = new Date(d); e.setHours(23, 59, 59, 999)
  return { s, e }
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
  console.log(`Connected. Night-shift test around ${DATE} → ${DATEP1}.`)

  const stamp = Date.now()
  const user = await User.create({ email: `smoke-nf-${stamp}@example.com`, password: 'smoke123', displayName: 'SMOKE NF Tutor' })
  const tutor = await TutorProfile.create({ tutorId: `SMOKE-NF-${stamp}`, userId: user._id, name: 'SMOKE NF Tutor', status: 'active' })
  const student = await Student.create({
    name: 'SMOKE NF Student', rollNo: `SMOKE-NF-${stamp}`, status: 'leave',
    performanceTags: ['risky', 'weak'], freshness: 'fresh', leaveStartDate: new Date(),
  })
  const tid = String(tutor._id)
  const sid = String(student._id)

  // Board sessions: evening (day D), after-midnight (D+1, in window), late morning (D+1, out of window)
  const sEve = await ClassSession.create({ studentId: student._id, tutorId: tutor._id, date: noon(DATE), scheduledStart: '21:00', scheduledEnd: '21:30', status: 'scheduled' })
  const sNight = await ClassSession.create({ studentId: student._id, tutorId: tutor._id, date: noon(DATEP1), scheduledStart: '01:00', scheduledEnd: '01:30', status: 'scheduled' })
  const sMorning = await ClassSession.create({ studentId: student._id, tutorId: tutor._id, date: noon(DATEP1), scheduledStart: '09:00', scheduledEnd: '09:30', status: 'scheduled' })

  const req = (body = {}, query = {}, params = {}, extra = {}) => ({
    userId: user._id, user: {}, body, query, params, ...extra,
  })

  try {
    // ── 1) Night-shift wrap board (20:00 → 07:00) ──
    let res = mockRes()
    await getBoard(req({}, { date: DATE, tutorId: tid, startHour: '20', endHour: '7' }), res)
    const sessions = res._json.sessions
    const find = (id) => sessions.find(s => String(s._id) === String(id))
    ok(!!find(sEve._id), 'wrap board includes the 21:00 evening session')
    ok(find(sEve._id)?.dayOffset === 0, 'evening session tagged dayOffset=0')
    ok(!!find(sNight._id), 'wrap board includes the next-day 01:00 session')
    ok(find(sNight._id)?.dayOffset === 1, 'after-midnight session tagged dayOffset=1')
    ok(!find(sMorning._id), 'next-day 09:00 (after 07:00 cutoff) is excluded')

    // ── 2) Student tag / leave / freshness surfaced on the board populate ──
    const stu = find(sEve._id)?.studentId
    ok(stu?.status === 'leave', 'board session carries student.status (leave)')
    ok(Array.isArray(stu?.performanceTags) && stu.performanceTags.includes('risky'), 'board session carries performanceTags')
    ok(stu?.freshness === 'fresh', 'board session carries freshness')

    // ── 3) Non-wrap board does NOT pull next-day sessions ──
    res = mockRes()
    await getBoard(req({}, { date: DATE, tutorId: tid, startHour: '8', endHour: '21' }), res)
    ok(res._json.sessions.some(s => String(s._id) === String(sEve._id)), 'day board still includes the evening session')
    ok(!res._json.sessions.some(s => String(s._id) === String(sNight._id)), 'day board excludes next-day sessions')

    // ── 4) Feedback: permission gating + create + delete ──
    const fbReq = (perms, body) => ({ userId: user._id, user: { displayName: 'SMOKE Admin' }, userPermissions: new Set(perms), params: { id: sid }, body })

    res = mockRes()
    await addStudentFeedback(fbReq([], { type: 'admin', text: 'should be blocked' }), res)
    ok(res._status === 403, 'admin feedback without permission is 403')

    res = mockRes()
    await addStudentFeedback(fbReq(['student.feedback_admin'], { type: 'admin', text: 'Needs stricter tajweed focus' }), res)
    ok(res._status === 201 && Array.isArray(res._json) && res._json.length === 1, 'admin feedback created with permission')

    res = mockRes()
    await addStudentFeedback(fbReq(['student.feedback_quality'], { type: 'quality', text: 'Pronunciation improving' }), res)
    ok(res._status === 201 && res._json.length === 2, 'quality feedback created with permission')

    res = mockRes()
    await addStudentFeedback(fbReq(['student.feedback_admin'], { type: 'bogus', text: 'x' }), res)
    ok(res._status === 400, 'invalid feedback type is 400')

    const quality = res._json?.find?.(f => f.type === 'quality') || (await Student.findById(sid).lean()).feedbacks.find(f => f.type === 'quality')
    res = mockRes()
    await deleteStudentFeedback({ userPermissions: new Set(['student.feedback_quality']), params: { id: sid, feedbackId: String(quality._id) } }, res)
    ok(res._status === 200 && res._json.length === 1, 'quality feedback deleted, admin one remains')

    // ── 5) Daily lesson joined into class history + pagination shape ──
    await LessonEntry.create({ studentId: student._id, tutorId: tutor._id, sessionId: sEve._id, date: noon(DATE), customText: 'Revised Surah Al-Fatiha' })
    res = mockRes()
    await getStudentClasses({ user: { roles: [{ key: 'admin' }] }, params: { id: sid }, query: { page: '1', limit: '20' } }, res)
    ok(Array.isArray(res._json.records) && res._json.total >= 3, 'getStudentClasses returns paginated records')
    const eveRow = res._json.records.find(r => String(r._id) === String(sEve._id))
    ok(eveRow?.taught === 'Revised Surah Al-Fatiha', 'class row shows the daily lesson taught')

    // ── 6) Progress detail returns feedbacks + taught on recent classes ──
    res = mockRes()
    await getStudentProgressDetail({
      user: { roles: [{ key: 'admin' }], linkedTutorId: null },
      userPermissions: new Set(['student_progress.read']),
      params: { id: sid }, query: {},
    }, res)
    ok(res._status === 200, 'progress detail returns 200')
    ok(Array.isArray(res._json.feedbacks) && res._json.feedbacks.length === 1, 'progress detail includes feedbacks')
    // author resolves from the populated createdBy user (displayName), falling back to createdByName
    ok(res._json.feedbacks[0]?.author === 'SMOKE NF Tutor', 'feedback author name populated from createdBy')
    const recEve = res._json.recentClasses.find(c => String(c._id) === String(sEve._id))
    ok(recEve?.taught === 'Revised Surah Al-Fatiha', 'recent class carries the daily lesson')

    // ── 7) Chat unread total ──
    const user2 = await User.create({ email: `smoke-nf2-${stamp}@example.com`, password: 'smoke123', displayName: 'SMOKE NF Reader' })
    const thread = await ChatThread.create({ type: 'channel', name: 'SMOKE NF', participants: [user._id, user2._id] })
    await Message.create({ threadId: thread._id, senderId: user._id, body: 'hello there' })
    res = mockRes()
    await getUnreadTotal({ userId: user2._id }, res)
    ok(res._json.total >= 1, `unread total counts the unread message (got ${res._json.total})`)
    res = mockRes()
    await getUnreadTotal({ userId: user._id }, res)
    ok(res._json.total === 0, 'sender has no unread of their own message')

    await Message.deleteMany({ threadId: thread._id })
    await ChatThread.deleteOne({ _id: thread._id })
    await User.deleteOne({ _id: user2._id })
  } finally {
    const { s, e } = dayRange(DATE)
    const { s: s2, e: e2 } = dayRange(DATEP1)
    await ClassSession.deleteMany({ date: { $gte: s, $lt: e } })
    await ClassSession.deleteMany({ date: { $gte: s2, $lt: e2 } })
    await LessonEntry.deleteMany({ studentId: student._id })
    await Student.deleteOne({ _id: student._id })
    await TutorProfile.deleteOne({ _id: tutor._id })
    await User.deleteOne({ _id: user._id })
    console.log('Cleaned up temp data.')
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  await mongoose.disconnect()
  process.exit(fail ? 1 : 0)
}
run().catch(e => { console.error('SMOKE ERROR:', e); process.exit(1) })

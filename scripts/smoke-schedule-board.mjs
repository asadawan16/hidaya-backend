// Smoke test for the Schedule Board feature.
// Verifies: getBoard (tutor columns + slot counts + day's sessions), the empty-cell
// create flow (createSlot → generateSessions materialises a session for an arbitrary
// date), updateSession (reschedule), track filter, and deleteSession. Creates temp
// User/TutorProfile/Student + a far-future dated slot/session, cleans everything up.
// Run: node scripts/smoke-schedule-board.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import ClassSlot from '../models/ClassSlot.js'
import ClassSession from '../models/ClassSession.js'
import TutorProfile from '../models/TutorProfile.js'
import Student from '../models/Student.js'
import User from '../models/User.js'
import '../models/Role.js'
import '../models/Log.js'
import {
  createSlot, generateSessionsForDate, getBoard, updateSession, deleteSession,
} from '../controllers/portalScheduleController.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }
function mockRes() {
  const res = { _status: 200, _json: null }
  res.status = (c) => { res._status = c; return res }
  res.json = (d) => { res._json = d; return res }
  return res
}
// getBoard reads req.user.* for scoping — pass an empty user so it uses query filters.
const req = (body = {}, query = {}, params = {}) => ({
  userId: new mongoose.Types.ObjectId(), user: {}, body, query, params,
})

const DATE = '2099-03-02' // isolated far-future day
const dayStart = new Date(DATE); dayStart.setHours(0, 0, 0, 0)
const dayEnd = new Date(DATE); dayEnd.setHours(23, 59, 59, 999)
const DOW = new Date(`${DATE}T00:00:00Z`).getUTCDay()

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
  console.log(`Connected. Test date ${DATE} (weekday ${DOW}). Creating temp records…`)

  const user = await User.create({
    email: `smoke-board-${Date.now()}@example.com`, password: 'smoke123', displayName: 'SMOKE Board Tutor',
  })
  const tutor = await TutorProfile.create({
    tutorId: `SMOKE-T-${Date.now()}`, userId: user._id, name: 'SMOKE Board Tutor', status: 'active',
  })
  const student = await Student.create({ name: 'SMOKE Board Student', rollNo: `SMOKE-BRD-${Date.now()}`, status: 'active' })
  const tid = String(tutor._id)

  try {
    // 1) Create a recurring slot on the test weekday (the empty-cell create action)
    let res = mockRes()
    await createSlot(req({
      studentId: String(student._id), tutorId: tid,
      dayOfWeek: DOW, startTime: '10:30', durationMinutes: 30, tracks: ['nazra'],
    }), res)
    ok(res._status === 201, 'createSlot returns 201')

    // 2) Board shows the tutor as a column with slotCount >= 1, no session yet
    res = mockRes()
    await getBoard(req({}, { date: DATE, tutorId: tid }), res)
    const col = res._json.tutors.find(t => String(t._id) === tid)
    ok(!!col, 'getBoard returns the tutor as a column')
    ok(col?.slotCount >= 1, `tutor slotCount reflects the recurring slot (got ${col?.slotCount})`)
    ok(res._json.sessions.length === 0, 'no session exists before generation')

    // 3) Generate sessions for the date → materialises our slot's session
    res = mockRes()
    await generateSessionsForDate(req({ date: DATE }), res)
    ok(res._json.created >= 1, `generateSessions created a session (created=${res._json.created})`)

    // 4) Board now shows the session in the 10:30 block, student populated
    res = mockRes()
    await getBoard(req({}, { date: DATE, tutorId: tid }), res)
    const sess = res._json.sessions.find(s => String(s.tutorId?._id || s.tutorId) === tid)
    ok(!!sess, 'getBoard returns the generated session for the tutor')
    ok(sess?.scheduledStart === '10:30' && sess?.scheduledEnd === '11:00', 'session sits in the 10:30–11:00 block')
    ok(sess?.studentId?.name === 'SMOKE Board Student', 'session has the populated student')

    // 5) Track filter excludes non-matching tracks
    res = mockRes()
    await getBoard(req({}, { date: DATE, tutorId: tid, track: 'hifz' }), res)
    ok(res._json.sessions.length === 0, 'track=hifz filter hides the nazra session')

    // 6) Reschedule via updateSession
    res = mockRes()
    await updateSession(req({ scheduledStart: '11:00', scheduledEnd: '11:30' }, {}, { id: String(sess._id) }), res)
    ok(res._json?.scheduledStart === '11:00', 'updateSession reschedules the session')
    ok(!!res._json?.tutorId?.name, 'updateSession returns a populated session')

    // 7) Delete via deleteSession
    res = mockRes()
    await deleteSession(req({}, {}, { id: String(sess._id) }), res)
    ok(res._json?.message === 'Session deleted', 'deleteSession removes the session')
    const after = await ClassSession.findById(sess._id).lean()
    ok(!after, 'session no longer exists in the DB')

    // 8) 404 on a missing session id
    res = mockRes()
    await updateSession(req({ notes: 'x' }, {}, { id: String(new mongoose.Types.ObjectId()) }), res)
    ok(res._status === 404, 'updateSession 404s for an unknown id')
  } finally {
    // Remove our slot/session plus any collateral generated on the far-future date
    await ClassSession.deleteMany({ date: { $gte: dayStart, $lt: dayEnd } })
    await ClassSlot.deleteMany({ tutorId: tutor._id })
    await TutorProfile.deleteOne({ _id: tutor._id })
    await User.deleteOne({ _id: user._id })
    await Student.deleteOne({ _id: student._id })
    console.log('Cleaned up temp data.')
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  await mongoose.disconnect()
  process.exit(fail ? 1 : 0)
}
run().catch(e => { console.error('SMOKE ERROR:', e); process.exit(1) })

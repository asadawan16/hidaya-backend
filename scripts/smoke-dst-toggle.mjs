// Smoke test for the Schedule page's daylight-saving toggle.
//
// Covers:
//   - the slot/session time math: midnight keeps the shift-day, the 7 AM wrap
//     changes it, and on → off is an exact round trip for every slot in the week
//   - turning DST on moves every slot (active or not) and every not-yet-started
//     session from the shift in progress onward; history keeps its time
//   - re-sending the same value moves nothing twice; turning it off restores
//     the original timetable exactly
//   - slots/sessions created while DST is on are marked, and session generation
//     never mints a duplicate for a slot whose started session kept the old time
//   - PUT /portal/schedule/dst is admin-only
//
// Runs against a THROWAWAY database (dbName hidaya_dst_smoke) and drops it.
// Needs MONGODB_URI and JWT_SECRET only. Run: node scripts/smoke-dst-toggle.mjs
import 'dotenv/config'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import User from '../models/User.js'
import Role from '../models/Role.js'
import ClassSlot from '../models/ClassSlot.js'
import ClassSession from '../models/ClassSession.js'
import ScheduleConfig from '../models/ScheduleConfig.js'
import { DEFAULT_ROLE_PERMISSIONS } from '../config/permissions.js'
import { shiftSlotTime, shiftSessionTime } from '../utils/dstShift.js'
import { setDaylightSaving, generateSessionsForDay, currentShiftDate } from '../controllers/portalScheduleController.js'
import portalScheduleRoutes from '../routes/portalScheduleRoutes.js'

let pass = 0, fail = 0
const ok = (c, m, detail = '') => {
  if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m, detail) }
}

// ── Pure time math (no DB) ───────────────────────────────────────────────────
console.log('\nTime math')
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
ok(eq(shiftSlotTime(1, '21:00', 60), { dayOfWeek: 1, startTime: '22:00' }), 'Mon 21:00 → Mon 22:00')
ok(eq(shiftSlotTime(1, '23:30', 60), { dayOfWeek: 1, startTime: '00:30' }), 'Mon 23:30 → 00:30, still Monday shift')
ok(eq(shiftSlotTime(1, '06:30', 60), { dayOfWeek: 2, startTime: '07:30' }), 'Mon-shift 06:30 → Tue 07:30 (crosses the 7 AM wrap)')
ok(eq(shiftSlotTime(2, '07:30', -60), { dayOfWeek: 1, startTime: '06:30' }), '…and Tue 07:30 back → Mon-shift 06:30')
ok(eq(shiftSlotTime(6, '06:45', 60), { dayOfWeek: 0, startTime: '07:45' }), 'Sat-shift 06:45 → Sun 07:45 (week wraps)')
ok(eq(shiftSlotTime(0, '07:00', -60), { dayOfWeek: 6, startTime: '06:00' }), 'Sun 07:00 back → Sat-shift 06:00')
let roundTrip = true
for (let d = 0; d < 7; d++) {
  for (let m = 0; m < 1440; m += 15) {
    const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    const on = shiftSlotTime(d, t, 60)
    const off = shiftSlotTime(on.dayOfWeek, on.startTime, -60)
    if (off.dayOfWeek !== d || off.startTime !== t) { roundTrip = false; console.error('    round trip broke at', d, t, on, off) }
  }
}
ok(roundTrip, 'on → off is an exact round trip for every 15-min slot of the week')
const sd = new Date('2026-11-02T00:00:00.000Z')
let st = shiftSessionTime(sd, '23:30', '24:00', 60)
ok(st.date.toISOString().startsWith('2026-11-03') && st.scheduledStart === '00:30' && st.scheduledEnd === '01:00', 'session 23:30 → next date 00:30–01:00', JSON.stringify(st))
st = shiftSessionTime(st.date, st.scheduledStart, st.scheduledEnd, -60)
ok(st.date.toISOString().startsWith('2026-11-02') && st.scheduledStart === '23:30' && st.scheduledEnd === '24:00', '…and back to 23:30–24:00 on the original date', JSON.stringify(st))

// ── Database ─────────────────────────────────────────────────────────────────
const SMOKE_DB = 'hidaya_dst_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
// Hard stop: everything below writes, and the finally block DROPS the database.
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
await mongoose.connection.dropDatabase() // leftovers from an aborted run

const app = express()
app.use(express.json())
app.use('/api/portal/schedule', portalScheduleRoutes)
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}/api/portal/schedule`
const tokenFor = (user) => jwt.sign({ id: user._id, type: 'portal' }, process.env.JWT_SECRET, { expiresIn: '10m' })
async function call(user, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(user)}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  return { status: res.status, data }
}

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay()
const at = (iso) => new Date(`${iso}T00:00:00.000Z`)
const dateOf = (s) => new Date(s.date).toISOString().slice(0, 10)

try {
  const shift = currentShiftDate()
  const dow = dowOf(shift)
  const ids = { studentId: new mongoose.Types.ObjectId(), tutorId: new mongoose.Types.ObjectId() }

  const slotEve = await ClassSlot.create({ ...ids, dayOfWeek: dow, startTime: '21:00' })
  const slotLate = await ClassSlot.create({ ...ids, dayOfWeek: dow, startTime: '23:30' })
  const slotTail = await ClassSlot.create({ ...ids, dayOfWeek: dow, startTime: '06:30' })
  const slotOff = await ClassSlot.create({ ...ids, dayOfWeek: (dow + 3) % 7, startTime: '20:00', active: false })

  const sess = (slot, date, start, end, status = 'scheduled') => ClassSession.create({
    slotId: slot?._id, ...ids, date: at(date), scheduledStart: start, scheduledEnd: end, status,
  })
  const sEve = await sess(slotEve, shift, '21:00', '21:30')
  const sLateStarted = await sess(slotLate, shift, '23:30', '24:00', 'started')
  const sTailStarted = await sess(slotTail, addDays(shift, 1), '06:30', '07:00', 'started')
  const sDone = await sess(slotEve, addDays(shift, -7), '21:00', '21:30', 'completed')
  const sStale = await sess(slotEve, addDays(shift, -7), '22:00', '22:30')
  const sFutureManual = await sess(null, addDays(shift, 5), '23:45', '24:15')

  console.log('\nTurning daylight saving ON')
  const on = await setDaylightSaving(true)
  ok(on.cfg.dstActive === true, 'config flag is on')
  ok(on.slotsShifted === 4, 'all 4 slots moved (inactive one too)', String(on.slotsShifted))
  ok(on.sessionsShifted === 2, 'only the 2 upcoming not-started sessions moved', String(on.sessionsShifted))
  let s = await ClassSlot.findById(slotEve._id).lean()
  ok(s.startTime === '22:00' && s.dayOfWeek === dow && s.dstShifted, 'evening slot 21:00 → 22:00')
  s = await ClassSlot.findById(slotLate._id).lean()
  ok(s.startTime === '00:30' && s.dayOfWeek === dow, 'late slot 23:30 → 00:30, same shift-day')
  s = await ClassSlot.findById(slotTail._id).lean()
  ok(s.startTime === '07:30' && s.dayOfWeek === (dow + 1) % 7, 'tail slot 06:30 → 07:30 the next weekday')
  let x = await ClassSession.findById(sEve._id).lean()
  ok(x.scheduledStart === '22:00' && x.scheduledEnd === '22:30' && dateOf(x) === shift && x.dstShifted, 'tonight 21:00 session → 22:00–22:30')
  x = await ClassSession.findById(sFutureManual._id).lean()
  ok(x.scheduledStart === '00:45' && x.scheduledEnd === '01:15' && dateOf(x) === addDays(shift, 6), 'future 23:45 session → 00:45 on the next date', JSON.stringify(x))
  for (const [doc, label] of [[sLateStarted, 'started'], [sTailStarted, 'started tail'], [sDone, 'completed'], [sStale, 'last week unactioned']]) {
    x = await ClassSession.findById(doc._id).lean()
    ok(x.scheduledStart === doc.scheduledStart && dateOf(x) === dateOf(doc) && !x.dstShifted, `${label} session keeps its time`)
  }

  const again = await setDaylightSaving(true)
  ok(again.slotsShifted === 0 && again.sessionsShifted === 0, 'sending ON again moves nothing twice')
  s = await ClassSlot.findById(slotEve._id).lean()
  ok(s.startTime === '22:00', '…slot still at 22:00')

  console.log('\nWhile it is on')
  const before = await ClassSession.countDocuments()
  await generateSessionsForDay(shift)
  await generateSessionsForDay(addDays(shift, 1))
  const lateCount = await ClassSession.countDocuments({ slotId: slotLate._id })
  const tailCount = await ClassSession.countDocuments({ slotId: slotTail._id })
  ok(lateCount === 1, 'no duplicate for the 23:30 slot whose started session kept the old time', String(lateCount))
  ok(tailCount === 1, 'no duplicate for the tail slot that crossed the 7 AM wrap', String(tailCount))
  const evCount = await ClassSession.countDocuments({ slotId: slotEve._id, date: at(shift) })
  ok(evCount === 1, 'no duplicate for the evening slot either', String(evCount))
  ok(await ClassSession.countDocuments() === before, 'generation added nothing for this shift')
  const fresh = await ClassSlot.create({ ...ids, dayOfWeek: dow, startTime: '20:00', dstShifted: true })
  await generateSessionsForDay(shift)
  x = await ClassSession.findOne({ slotId: fresh._id }).lean()
  ok(x && x.scheduledStart === '20:00' && x.dstShifted === true, 'sessions generated from a DST-time slot are marked')

  console.log('\nTurning daylight saving OFF')
  const off = await setDaylightSaving(false)
  ok(off.cfg.dstActive === false, 'config flag is off')
  for (const [slot, label] of [[slotEve, 'evening'], [slotLate, 'late'], [slotTail, 'tail'], [slotOff, 'inactive']]) {
    s = await ClassSlot.findById(slot._id).lean()
    ok(s.startTime === slot.startTime && s.dayOfWeek === slot.dayOfWeek && !s.dstShifted, `${label} slot back to ${slot.startTime}`, JSON.stringify(s))
  }
  s = await ClassSlot.findById(fresh._id).lean()
  ok(s.startTime === '19:00', 'a slot created during DST moves back an hour too')
  x = await ClassSession.findById(sEve._id).lean()
  ok(x.scheduledStart === '21:00' && dateOf(x) === shift, 'tonight session back to 21:00')
  x = await ClassSession.findById(sFutureManual._id).lean()
  ok(x.scheduledStart === '23:45' && x.scheduledEnd === '24:15' && dateOf(x) === addDays(shift, 5), 'future session back to 23:45 on its original date')

  console.log('\nRoute guard')
  const roles = {}
  for (const key of ['super_admin', 'admin', 'qci']) {
    roles[key] = await Role.create({ key, name: key, permissions: DEFAULT_ROLE_PERMISSIONS[key], system: true })
  }
  const mk = (n, role) => User.create({ email: `${n}@smoke.test`, password: 'Smoke@12345', displayName: n, roles: [roles[role]._id] })
  const admin = await mk('admin', 'admin')
  const qci = await mk('qci', 'qci')
  let r = await call(qci, 'PUT', '/dst', { enabled: true })
  ok(r.status === 403, 'QCI (schedule.manage but not admin) is refused', String(r.status))
  r = await call(admin, 'PUT', '/dst', { enabled: 'yes' })
  ok(r.status === 400, 'non-boolean body is refused')
  r = await call(admin, 'PUT', '/dst', { enabled: true })
  ok(r.status === 200 && r.data?.dstActive === true && r.data.slotsShifted === 5, 'admin turns it on', JSON.stringify(r.data))
  r = await call(qci, 'GET', '/config')
  ok(r.status === 200 && r.data?.dstActive === true && r.data.dstShiftMinutes === 60, 'config reports it to schedule readers')
  r = await call(admin, 'PUT', '/dst', { enabled: false })
  ok(r.status === 200 && r.data?.dstActive === false, 'admin turns it off')
  ok((await ScheduleConfig.findOne({ key: 'default' }).lean()).dstChangedBy?.toString() === admin._id.toString(), 'who flipped it is recorded')
} catch (err) {
  fail++
  console.error('\nSmoke aborted:', err)
} finally {
  server.close()
  if (mongoose.connection.name === SMOKE_DB) await mongoose.connection.dropDatabase().catch(e => console.error('drop failed:', e.message))
  await mongoose.disconnect()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

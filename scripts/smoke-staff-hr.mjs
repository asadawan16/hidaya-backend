// Smoke test for the staff HR surfaces: Employee IDs, staff leave, and the
// org-wide payroll summary on the salary roster.
//
// Covers:
//   - every staff member gets an Employee ID (E01…), oldest account first; the
//     super admin and tutors do not; IDs are stable, searchable and editable,
//     duplicates are refused, and concurrent numbering never hands out one twice
//   - management can file their OWN leave (reviewer or not) and see only what
//     they are allowed to; a reviewer cannot approve their own request
//   - approving staff leave writes staff attendance rows and keeps the review note
//   - tutor leave still works, including requests stored before staff leave existed
//   - the salary roster's summary covers tutors + staff + off-portal people
//     whatever scope is requested, per currency, with Total = Paid + Remaining
//   - a salary generated for someone since deactivated stays on that month's sheet
//
// Mounts the real routers on an in-process Express app. Runs against a
// THROWAWAY database (dbName hidaya_staff_hr_smoke) on the same cluster and
// drops it afterwards — production collections are never touched.
// Needs MONGODB_URI and JWT_SECRET only.
// Run: node scripts/smoke-staff-hr.mjs
import 'dotenv/config'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import User from '../models/User.js'
import Role from '../models/Role.js'
import TutorProfile from '../models/TutorProfile.js'
import StaffProfile from '../models/StaffProfile.js'
import LeaveRequest from '../models/LeaveRequest.js'
import TutorAttendance from '../models/TutorAttendance.js'
import Notification from '../models/Notification.js'
import { DEFAULT_ROLE_PERMISSIONS } from '../config/permissions.js'
import { ensureEmployeeIds } from '../utils/employeeId.js'
import portalLeaveRoutes from '../routes/portalLeaveRoutes.js'
import portalStaffRoutes from '../routes/portalStaffRoutes.js'
import portalFinanceRoutes from '../routes/portalFinanceRoutes.js'

let pass = 0, fail = 0
const ok = (c, m, detail = '') => {
  if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m, detail) }
}

const SMOKE_DB = 'hidaya_staff_hr_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
// Hard stop: everything below writes, and the finally block DROPS the database.
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
await mongoose.connection.dropDatabase() // leftovers from an aborted run
await User.init() // the unique employeeId index must exist before the race test

const app = express()
app.use(express.json())
app.use('/api/portal/leaves', portalLeaveRoutes)
app.use('/api/portal/staff', portalStaffRoutes)
app.use('/api/portal/finance', portalFinanceRoutes)
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}/api/portal`

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

const day = (n) => { const d = new Date(Date.UTC(new Date().getFullYear(), 5, n)); return d.toISOString().slice(0, 10) }
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0)

try {
  const roles = {}
  for (const key of ['super_admin', 'admin', 'coordinator', 'qcm', 'tutor']) {
    roles[key] = await Role.create({ key, name: key, permissions: DEFAULT_ROLE_PERMISSIONS[key], system: true })
  }
  // Created one at a time so createdAt — the numbering order — is unambiguous.
  const mkUser = (name, role, extra = {}) => User.create({
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@smoke.test`, password: 'Smoke@12345',
    displayName: name, roles: [roles[role]._id], ...extra,
  })
  const boss = await mkUser('Boss Owner', 'super_admin')
  const admin = await mkUser('Zed Admin', 'admin')
  const coord = await mkUser('Amna Coordinator', 'coordinator')
  const qcm = await mkUser('Bilal Qcm', 'qcm')
  const tutorUser = await mkUser('Tariq Tutor', 'tutor')
  const tutor = await TutorProfile.create({
    tutorId: 'T01', userId: tutorUser._id, name: 'Tariq Tutor', status: 'active',
    salary: { baseAmount: 30000, currency: 'PKR' },
  })
  await User.updateOne({ _id: tutorUser._id }, { $set: { linkedTutorId: tutor._id } })

  // ── Employee IDs ───────────────────────────────────────────────────────────
  console.log('\nEmployee IDs')
  let r = await call(admin, 'GET', '/staff?limit=50')
  const ids = Object.fromEntries((r.data?.records || []).map(u => [u.displayName, u.employeeId]))
  ok(r.status === 200 && r.data.records.length === 3, 'staff list = admin, coordinator, qcm (no super admin, no tutor)', JSON.stringify(ids))
  ok(ids['Zed Admin'] === 'E01' && ids['Amna Coordinator'] === 'E02' && ids['Bilal Qcm'] === 'E03',
    'IDs numbered E01… in the order the accounts were created', JSON.stringify(ids))
  const untouched = await User.find({ _id: { $in: [boss._id, tutorUser._id] } }).select('employeeId').lean()
  ok(untouched.every(u => u.employeeId === undefined), 'super admin and tutor are not numbered')

  r = await call(admin, 'GET', '/staff?limit=50')
  ok(r.data.records.every(u => u.employeeId === ids[u.displayName]), 'IDs are stable across reads')

  r = await call(admin, 'PATCH', `/staff/${coord._id}`, { employeeId: ' hr-7 ' })
  ok(r.status === 200 && r.data?.employeeId === 'HR-7', 'Employee ID is editable (trimmed + uppercased)', JSON.stringify(r.data))
  r = await call(admin, 'PATCH', `/staff/${qcm._id}`, { employeeId: 'HR-7' })
  ok(r.status === 400 && /already used/i.test(r.data?.error || ''), 'duplicate Employee ID is refused', JSON.stringify(r.data))
  r = await call(admin, 'PATCH', `/staff/${qcm._id}`, { employeeId: 'bad id!' })
  ok(r.status === 400, 'malformed Employee ID is refused')
  r = await call(admin, 'PATCH', `/staff/${coord._id}`, { employeeId: '', title: 'Coordinator' })
  ok(r.status === 200 && r.data?.employeeId === 'HR-7' && r.data?.title === 'Coordinator', 'a blank ID keeps the existing one; other fields still save')
  r = await call(coord, 'PATCH', `/staff/${qcm._id}`, { employeeId: 'X1' })
  ok(r.status === 403, 'editing needs staff.manage')

  r = await call(admin, 'GET', '/staff?search=hr-7')
  ok(r.data?.records?.length === 1 && r.data.records[0].displayName === 'Amna Coordinator', 'staff search matches the Employee ID')
  r = await call(admin, 'GET', '/staff/picker?q=E03')
  ok(r.data?.length === 1 && r.data[0].employeeId === 'E03', 'staff picker matches + returns the Employee ID')

  const late = await mkUser('Late Joiner', 'coordinator')
  r = await call(admin, 'GET', `/staff/${late._id}`)
  ok(r.data?.user?.employeeId === 'E04', 'a new staff member gets the next number (E02 is not recycled)', r.data?.user?.employeeId)

  const batch = []
  for (let i = 0; i < 6; i++) batch.push(await mkUser(`Race ${i}`, 'qcm'))
  const batchFilter = { _id: { $in: batch.map(u => u._id) } }
  await Promise.all([ensureEmployeeIds(batchFilter), ensureEmployeeIds(batchFilter), ensureEmployeeIds(batchFilter)])
  const raced = (await User.find(batchFilter).select('employeeId').lean()).map(u => u.employeeId)
  ok(raced.every(Boolean) && new Set(raced).size === 6, 'three concurrent numbering passes hand out 6 distinct IDs', raced.join(','))
  await User.deleteMany({ _id: { $in: [...batch.map(u => u._id), late._id] } })

  // ── Staff leave ────────────────────────────────────────────────────────────
  console.log('\nLeave — management')
  const leaveBody = (from, to, extra = {}) => ({ leaveType: 'casual', startDate: day(from), endDate: day(to), reason: 'Smoke', ...extra })

  r = await call(qcm, 'POST', '/leaves', leaveBody(1, 2))
  ok(r.status === 201 && r.data?.subjectType === 'staff' && String(r.data.userId?._id) === String(qcm._id) && !r.data.tutorId,
    'non-reviewer staff can file their own leave', JSON.stringify(r.data))
  ok(r.data?.userId?.employeeId === 'E03', 'the request carries the Employee ID')
  const qcmLeave = r.data

  r = await call(coord, 'POST', '/leaves', leaveBody(3, 5))
  ok(r.status === 201 && r.data?.subjectType === 'staff' && String(r.data.userId?._id) === String(coord._id),
    'a reviewer naming nobody files their own leave (was: "tutorId is required")', JSON.stringify(r.data))
  const coordLeave = r.data

  r = await call(coord, 'POST', '/leaves', leaveBody(4, 6))
  ok(r.status === 400 && /overlapping/i.test(r.data?.error || ''), 'overlapping staff leave is refused')

  r = await call(qcm, 'GET', '/leaves')
  ok(r.data?.total === 1 && r.data.records[0]._id === qcmLeave._id, 'non-reviewer staff see only their own requests')
  r = await call(qcm, 'GET', `/leaves?userId=${coord._id}`)
  ok(r.data?.total === 1 && r.data.records[0]._id === qcmLeave._id, '…even when asking for someone else by id')
  r = await call(qcm, 'POST', '/leaves', leaveBody(10, 10, { userId: String(coord._id) }))
  ok(r.status === 201 && String(r.data.userId?._id) === String(qcm._id), 'a non-reviewer cannot file on behalf of someone else')

  r = await call(coord, 'POST', `/leaves/${coordLeave._id}/review`, { status: 'approved' })
  ok(r.status === 403, 'a reviewer cannot approve their own leave', JSON.stringify(r.data))
  r = await call(qcm, 'POST', `/leaves/${qcmLeave._id}/review`, { status: 'approved' })
  ok(r.status === 403, 'reviewing needs leave.review')

  r = await call(admin, 'POST', `/leaves/${coordLeave._id}/review`, { status: 'approved', notes: 'Enjoy' })
  ok(r.status === 200 && r.data?.status === 'approved' && r.data.reviewNotes === 'Enjoy', 'another reviewer approves it and the note is kept', JSON.stringify(r.data))
  const absences = await TutorAttendance.find({ userId: coord._id }).lean()
  ok(absences.length === 3 && absences.every(a => a.subjectType === 'staff' && a.status === 'absent' && !a.tutorId),
    'approval marks the 3 days absent in STAFF attendance', JSON.stringify(absences.map(a => [a.subjectType, a.status])))
  const told = await Notification.findOne({ userId: coord._id, type: 'leave_approved' }).lean()
  ok(!!told && /Enjoy/.test(told.body), 'the staff member is notified of the decision')
  ok(await Notification.countDocuments({ userId: admin._id, type: 'leave_request' }) >= 2, 'reviewers are notified of staff requests')

  const bossLeave = await call(boss, 'POST', '/leaves', leaveBody(20, 20))
  r = await call(boss, 'POST', `/leaves/${bossLeave.data?._id}/review`, { status: 'approved' })
  ok(bossLeave.status === 201 && r.status === 200, 'the super admin can file and sign off their own')

  console.log('\nLeave — tutors (unchanged)')
  r = await call(tutorUser, 'POST', '/leaves', leaveBody(1, 1, { userId: String(coord._id) }))
  ok(r.status === 201 && String(r.data?.tutorId?._id) === String(tutor._id) && !r.data.userId, 'a tutor files against their tutor profile', JSON.stringify(r.data))
  r = await call(tutorUser, 'GET', '/leaves')
  ok(r.data?.total === 1, 'a tutor sees only their own')
  r = await call(admin, 'POST', '/leaves', leaveBody(8, 9, { tutorId: String(tutor._id) }))
  ok(r.status === 201 && String(r.data?.tutorId?._id) === String(tutor._id), 'a reviewer can file for a tutor')
  r = await call(admin, 'POST', '/leaves', leaveBody(12, 12, { userId: String(qcm._id) }))
  ok(r.status === 201 && r.data?.subjectType === 'staff' && String(r.data.userId?._id) === String(qcm._id), 'a reviewer can file for a staff member')
  r = await call(admin, 'POST', '/leaves', leaveBody(14, 14, { userId: String(tutorUser._id) }))
  ok(r.status === 201 && String(r.data?.tutorId?._id) === String(tutor._id), "a tutor picked by login still lands on the tutor's profile")
  r = await call(admin, 'POST', '/leaves', leaveBody(15, 15, { tutorId: String(new mongoose.Types.ObjectId()) }))
  ok(r.status === 400, 'an unknown tutor is refused')

  // A request stored before staff leave existed: no subjectType on the document.
  const legacy = await LeaveRequest.collection.insertOne({
    tutorId: tutor._id, requestedBy: tutorUser._id, leaveType: 'sick', reason: 'Legacy',
    startDate: new Date(day(25)), endDate: new Date(day(25)), status: 'pending', totalDays: 1,
    createdAt: new Date(), updatedAt: new Date(),
  })
  r = await call(admin, 'GET', '/leaves?subjectType=tutor&limit=50')
  ok(r.data?.records?.some(l => l._id === String(legacy.insertedId)) && r.data.records.every(l => l.subjectType !== 'staff'),
    'the Tutors filter includes pre-existing requests and no staff ones')
  r = await call(admin, 'GET', '/leaves?subjectType=staff&limit=50')
  ok(r.data?.total === 5 && r.data.records.every(l => l.subjectType === 'staff'), 'the Staff filter returns only staff requests', String(r.data?.total))
  r = await call(admin, 'GET', '/leaves?limit=50')
  ok(r.data?.total === 9, 'a reviewer sees everyone by default', String(r.data?.total))
  r = await call(admin, 'GET', '/leaves?mine=1')
  ok(r.data?.total === 0, '"mine" narrows a reviewer to their own')
  r = await call(admin, 'POST', `/leaves/${legacy.insertedId}/review`, { status: 'approved' })
  ok(r.status === 200 && (await TutorAttendance.countDocuments({ tutorId: tutor._id })) === 1, 'a pre-existing tutor request can still be approved')

  r = await call(admin, 'GET', '/leaves/stats')
  ok(r.data?.approved === 3 && r.data.totalDays === 5, 'stats: 3 approved, 5 days used (was always 0)', JSON.stringify(r.data))
  r = await call(coord, 'GET', '/leaves/stats?mine=1')
  ok(r.data?.approved === 1 && r.data.totalDays === 3, "stats narrow to the caller's own", JSON.stringify(r.data))
  r = await call(qcm, 'GET', '/leaves/stats')
  ok(r.data?.pending === 3 && r.data.approved === 0, "a non-reviewer's stats are their own", JSON.stringify(r.data))

  // ── Payroll summary ────────────────────────────────────────────────────────
  console.log('\nPayroll summary')
  const now = new Date()
  const period = { month: now.getMonth() + 1, year: now.getFullYear() }
  const q = `month=${period.month}&year=${period.year}`
  await StaffProfile.findOneAndUpdate({ userId: coord._id }, { $set: { baseSalary: 50000, salaryCurrency: 'PKR' } }, { upsert: true })
  await StaffProfile.findOneAndUpdate({ userId: qcm._id }, { $set: { baseSalary: 400, salaryCurrency: 'USD' } }, { upsert: true })

  r = await call(admin, 'POST', '/finance/salary/generate', { tutorId: String(tutor._id), ...period, extraMoney: 2000 })
  const tutorSalary = r.data
  ok(r.status === 201 && tutorSalary?.netPayable === 32000, 'tutor salary generated (30,000 + 2,000)')
  r = await call(admin, 'PATCH', `/finance/salary/${tutorSalary._id}`, { status: 'paid' })
  ok(r.status === 200 && r.data?.status === 'paid', 'tutor salary marked paid')
  r = await call(admin, 'POST', '/finance/salary/generate', { userId: String(coord._id), ...period, fine: 1000 })
  ok(r.status === 201 && r.data?.netPayable === 49000, 'staff salary generated, unpaid (50,000 − 1,000)')
  r = await call(admin, 'POST', '/finance/salary/generate', { subjectType: 'custom', personName: 'Gate Guard', personRole: 'Security', baseAmount: 15000, ...period })
  ok(r.status === 201, 'off-portal salary generated, unpaid')

  r = await call(admin, 'GET', `/finance/salary/roster?${q}`)
  const s = r.data?.summary
  ok(r.data?.scope === 'tutor' && r.data.roster.length === 1, 'default scope still lists tutors only')
  ok(s?.employees?.total === 5 && s.employees.tutors === 1 && s.employees.staff === 3 && s.employees.other === 1,
    'summary counts everyone: 1 tutor + 3 staff + 1 other', JSON.stringify(s?.employees))
  // PKR: tutor 32,000 paid · coordinator 49,000 · guard 15,000 · admin 0 (no base set)
  ok(s?.byCurrency?.PKR?.total === 96000 && s.byCurrency.PKR.paid === 32000 && s.byCurrency.PKR.remaining === 64000,
    'PKR: total 96,000 = paid 32,000 + remaining 64,000', JSON.stringify(s?.byCurrency))
  ok(s?.byCurrency?.USD?.total === 400 && s.byCurrency.USD.paid === 0 && s.byCurrency.USD.remaining === 400,
    'USD kept apart: a not-yet-generated salary counts at base (400)', JSON.stringify(s?.byCurrency))
  ok(s?.paidCount === 1 && s.remainingCount === 4 && s.notGenerated === 2, '1 paid, 4 remaining, 2 not generated yet',
    JSON.stringify([s?.paidCount, s?.remainingCount, s?.notGenerated]))
  ok(Object.values(s?.byCurrency || {}).every(b => b.total === b.paid + b.remaining), 'Total = Paid + Remaining in every currency')

  const scoped = await Promise.all(['staff', 'custom', 'all'].map(sc => call(admin, 'GET', `/finance/salary/roster?${q}&scope=${sc}`)))
  ok(scoped.every(x => JSON.stringify(x.data?.summary) === JSON.stringify(s)), 'the summary is identical whatever scope the sheet shows')
  ok(scoped[0].data.roster.length === 3 && scoped[1].data.roster.length === 1 && scoped[2].data.roster.length === 5, 'each scope still lists only its own rows')
  const staffRow = scoped[0].data.roster.find(x => String(x.userId?._id) === String(coord._id))
  ok(staffRow?.userId?.employeeId === 'HR-7' && staffRow.record?.userId?.employeeId === 'HR-7', 'staff rows (and their records) carry the Employee ID')
  ok(sum(Object.fromEntries(scoped[2].data.roster.map((x, i) => [i, x.record ? x.record.netPayable : x.baseAmount])))
    === 96000 + 400, 'the "All" sheet adds up to the summary')

  await TutorProfile.updateOne({ _id: tutor._id }, { $set: { status: 'inactive' } })
  await User.updateOne({ _id: coord._id }, { $set: { status: 'suspended' } })
  r = await call(admin, 'GET', `/finance/salary/roster?${q}&scope=all`)
  ok(r.data?.roster?.some(x => x.record?._id === tutorSalary._id) && r.data.summary.byCurrency.PKR.paid === 32000,
    "a deactivated tutor's paid salary stays on that month's sheet")
  ok(r.data?.roster?.some(x => String(x.userId?._id) === String(coord._id) && x.record?.netPayable === 49000)
    && r.data.summary.byCurrency.PKR.total === 96000, "…and so does a suspended staff member's generated salary")
  const next = period.month === 12 ? { month: 1, year: period.year + 1 } : { month: period.month + 1, year: period.year }
  r = await call(admin, 'GET', `/finance/salary/roster?month=${next.month}&year=${next.year}&scope=all`)
  ok(r.data?.roster?.length === 2 && r.data.summary.employees.total === 2, 'next month they are gone (only still-active people are expected)', String(r.data?.roster?.length))
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

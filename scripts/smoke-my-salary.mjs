// Smoke test for the employee self-service salary history (My Salary page):
// GET /api/portal/finance/salary/mine
//
//   - a tutor sees only their own rows, with no salary.read
//   - a tutor whose linkedTutorId was never backfilled is found via TutorProfile.userId
//   - a staff member sees only their own (userId) rows
//   - a student account is refused
//   - the summary is per currency (never summed across), with latest paid + awaiting
//   - pagination
//
// Runs against a THROWAWAY database (dbName hidaya_my_salary_smoke) on the same
// cluster and drops it at the end. No running server needed — the router is
// mounted on an in-process express app. Needs MONGODB_URI and JWT_SECRET only.
// Run: node scripts/smoke-my-salary.mjs
import 'dotenv/config'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import User from '../models/User.js'
import Role from '../models/Role.js'
import TutorProfile from '../models/TutorProfile.js'
import SalaryRecord from '../models/SalaryRecord.js'
import { DEFAULT_ROLE_PERMISSIONS } from '../config/permissions.js'
import portalFinanceRoutes from '../routes/portalFinanceRoutes.js'

let pass = 0, fail = 0
const ok = (c, m, detail = '') => {
  if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m, detail) }
}

const SMOKE_DB = 'hidaya_my_salary_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
// Hard stop: everything below writes, and the finally block DROPS the database.
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
await mongoose.connection.dropDatabase()
await SalaryRecord.init()

const app = express()
app.use(express.json())
app.use('/api/portal/finance', portalFinanceRoutes)
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}/api/portal/finance`

const tokenFor = (user) => jwt.sign({ id: user._id, type: 'portal' }, process.env.JWT_SECRET, { expiresIn: '10m' })
async function get(user, path) {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${tokenFor(user)}` } })
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  return { status: res.status, data }
}

const YEAR = new Date().getFullYear()

try {
  const roles = {}
  for (const key of ['super_admin', 'coordinator', 'tutor', 'student']) {
    roles[key] = await Role.create({ key, name: key, permissions: DEFAULT_ROLE_PERMISSIONS[key] || [], system: true })
  }
  const mkUser = (name, role, extra = {}) => User.create({
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@smoke.test`, password: 'Smoke@12345',
    displayName: name, roles: [roles[role]._id], ...extra,
  })

  const boss = await mkUser('Boss Owner', 'super_admin')
  const coord = await mkUser('Amna Coordinator', 'coordinator', { employeeId: 'E01' })
  const tutorUser = await mkUser('Tariq Tutor', 'tutor')
  const tutor = await TutorProfile.create({ tutorId: 'T01', userId: tutorUser._id, name: 'Tariq Tutor', status: 'active' })
  await User.updateOne({ _id: tutorUser._id }, { $set: { linkedTutorId: tutor._id } })
  // Never backfilled: owns a TutorProfile, but linkedTutorId is unset.
  const legacyUser = await mkUser('Legacy Tutor', 'tutor')
  const legacy = await TutorProfile.create({ tutorId: 'T02', userId: legacyUser._id, name: 'Legacy Tutor', status: 'active' })
  const studentUser = await mkUser('Sara Student', 'student', { linkedStudentId: new mongoose.Types.ObjectId() })

  const row = (subject, month, year, extra = {}) => SalaryRecord.create({
    ...subject, month, year, baseAmount: 30000, netPayable: 30000, currency: 'PKR', status: 'paid', paidAt: new Date(year, month, 1), ...extra,
  })
  // Tutor: 14 months — 13 paid PKR (one last year), one USD paid, plus one finalized and one draft.
  for (let m = 1; m <= 12; m++) await row({ subjectType: 'tutor', tutorId: tutor._id }, m, YEAR - 1)
  await row({ subjectType: 'tutor', tutorId: tutor._id }, 1, YEAR, { netPayable: 28000, fine: 2000, receiptNo: 'SR-00099' })
  await row({ subjectType: 'tutor', tutorId: tutor._id }, 2, YEAR, { currency: 'USD', baseAmount: 200, netPayable: 200 })
  await row({ subjectType: 'tutor', tutorId: tutor._id }, 3, YEAR, { status: 'finalized', paidAt: undefined })
  await row({ subjectType: 'tutor', tutorId: tutor._id }, 4, YEAR, { status: 'draft', paidAt: undefined })
  await row({ subjectType: 'tutor', tutorId: legacy._id }, 1, YEAR, { netPayable: 25000 })
  await row({ subjectType: 'staff', userId: coord._id }, 1, YEAR, { netPayable: 50000 })
  await row({ subjectType: 'custom', personName: 'Guard', personRole: 'Security' }, 1, YEAR, { netPayable: 15000 })

  console.log('\nTutor')
  let r = await get(tutorUser, '/salary/mine?limit=50')
  ok(r.status === 200, 'tutor can read their own history without salary.read', JSON.stringify(r.data))
  ok(r.data?.total === 16 && r.data.records.every(x => String(x.tutorId?._id) === String(tutor._id)), 'only their own 16 rows', r.data?.total)
  ok(r.data?.records?.[0]?.month === 4 && r.data.records[0].year === YEAR, 'newest month first')
  ok(r.data?.records?.[0]?.tutorId?.name === 'Tariq Tutor', 'subject populated for the slip')
  const pkr = r.data?.summary?.byCurrency?.find(c => c.currency === 'PKR')
  const usd = r.data?.summary?.byCurrency?.find(c => c.currency === 'USD')
  ok(pkr?.paidThisYear === 28000 && pkr?.paidTotal === 12 * 30000 + 28000 && pkr?.paidCount === 13, 'PKR totals (this year + lifetime)', JSON.stringify(pkr))
  ok(usd?.paidThisYear === 200 && usd?.paidCount === 1, 'USD totalled separately, never added to PKR', JSON.stringify(usd))
  ok(r.data?.summary?.latestPaid?.month === 2 && r.data.summary.latestPaid.year === YEAR, 'latest paid = most recent paid month (skips finalized/draft)')
  ok(r.data?.summary?.awaiting === 1, 'one finalized row awaiting payment')
  ok(r.data?.records?.every(x => x.generatedBy === undefined), 'internal fields not exposed')

  r = await get(tutorUser, '/salary/mine?page=2&limit=12')
  ok(r.data?.page === 2 && r.data?.pages === 2 && r.data?.records?.length === 4, 'pagination', JSON.stringify({ page: r.data?.page, pages: r.data?.pages, n: r.data?.records?.length }))

  r = await get(tutorUser, '/salary')
  ok(r.status === 403, 'the org-wide salary list stays closed to tutors')

  console.log('\nTutor with no linkedTutorId')
  r = await get(legacyUser, '/salary/mine')
  ok(r.status === 200 && r.data?.total === 1 && r.data.records[0].netPayable === 25000, 'found via TutorProfile.userId', JSON.stringify(r.data?.records))

  console.log('\nStaff')
  r = await get(coord, '/salary/mine')
  ok(r.status === 200 && r.data?.total === 1 && r.data.records[0].userId?.employeeId === 'E01', 'staff sees only their own row, with Employee ID', JSON.stringify(r.data?.records))

  console.log('\nOthers')
  r = await get(boss, '/salary/mine')
  ok(r.status === 200 && r.data?.total === 0 && r.data?.summary?.latestPaid === null, 'super admin (not on payroll) gets an empty history')
  r = await get(studentUser, '/salary/mine')
  ok(r.status === 403, 'student accounts are refused')
} catch (err) {
  fail++
  console.error('Smoke crashed:', err)
} finally {
  server.close()
  if (mongoose.connection.name === SMOKE_DB) await mongoose.connection.dropDatabase().catch(e => console.error('drop failed:', e.message))
  await mongoose.disconnect()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

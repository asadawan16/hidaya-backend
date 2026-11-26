// Smoke test for the Fee Tracker (/api/portal/fee-tracker):
//
//   - only fee.tracker holders get in (super admin by default; admin and tutor don't)
//   - one row per family, sorted by roll number; on-leave students stay on it
//   - owed months come from Fee Management (received / waived / partial / base fee)
//     from January 2026 or the joining month, whichever is later
//   - families with nothing due are left off; paid in Fee Management shows as received
//   - link sent / ignore / expected override are per month and start clean next month
//   - a receipt covers several students and months, including another family's
//     student, numbers itself FT-YYYY-NNNN, and can be undone
//   - Fee Management (StudentFeeRecord / FeePayment) is never written
//
// Runs against a THROWAWAY database (dbName hidaya_fee_tracker_smoke) on the same
// cluster and drops it at the end. No running server needed — the router is
// mounted on an in-process express app. Needs MONGODB_URI and JWT_SECRET only.
// Run: node scripts/smoke-fee-tracker.mjs
import 'dotenv/config'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import User from '../models/User.js'
import Role from '../models/Role.js'
import Student from '../models/Student.js'
import Family from '../models/Family.js'
import StudentFeeRecord from '../models/StudentFeeRecord.js'
import FeePayment from '../models/FeePayment.js'
import FeeTrackerEntry from '../models/FeeTrackerEntry.js'
import FeeTrackerReceipt from '../models/FeeTrackerReceipt.js'
import { DEFAULT_ROLE_PERMISSIONS } from '../config/permissions.js'
import portalFeeTrackerRoutes from '../routes/portalFeeTrackerRoutes.js'

let pass = 0, fail = 0
const ok = (c, m, detail = '') => {
  if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m, detail) }
}

const SMOKE_DB = 'hidaya_fee_tracker_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
// Hard stop: everything below writes, and the finally block DROPS the database.
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
await mongoose.connection.dropDatabase()
await Promise.all([FeeTrackerEntry.init(), FeeTrackerReceipt.init(), StudentFeeRecord.init()])

const app = express()
app.use(express.json())
app.use('/api/portal/fee-tracker', portalFeeTrackerRoutes)
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}/api/portal/fee-tracker`

const tokenFor = (user) => jwt.sign({ id: user._id, type: 'portal' }, process.env.JWT_SECRET, { expiresIn: '10m' })
async function call(user, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${tokenFor(user)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  return { status: res.status, data }
}
const NOV = 'year=2026&month=11'
const board = async (user, q = NOV) => (await call(user, 'GET', `/?${q}`)).data
const rowOf = (b, rollNo) => b.rows.find(r => r.members.some(m => m.rollNo === rollNo))

try {
  const roles = {}
  for (const key of ['super_admin', 'admin', 'tutor']) {
    roles[key] = await Role.create({ key, name: key, permissions: DEFAULT_ROLE_PERMISSIONS[key] || [], system: true })
  }
  const mkUser = (name, role) => User.create({
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@smoke.test`, password: 'Smoke@12345',
    displayName: name, roles: [roles[role]._id],
  })
  const boss = await mkUser('Boss Owner', 'super_admin')
  const admin = await mkUser('Ali Admin', 'admin')
  const tutor = await mkUser('Tariq Tutor', 'tutor')

  // ── Students ──
  const f1 = await Family.create({ familyCode: 'FAM-1', primaryGuardian: { name: 'Mrs Tahir' } })
  const f2 = await Family.create({ familyCode: 'FAM-2', primaryGuardian: { name: 'Mr Faliq' } })
  const f3 = await Family.create({ familyCode: 'FAM-3' })
  const mk = (rollNo, name, extra) => Student.create({
    rollNo, name, status: 'active', joiningDate: new Date('2019-07-10'),
    billing: { fee: 7000, currency: 'PKR', paymentMethod: 'SC' }, ...extra,
  })
  // Family 1: Oct pending (no amount → base fee), Nov nothing; a sibling on leave who joined in October (NSY).
  const zara = await mk('HID30', 'Zara', { familyId: f1._id })
  const ali = await mk('HID31', 'Ali', { familyId: f1._id, status: 'leave', joiningDate: new Date('2026-10-05'), billing: { fee: 5000, paymentMethod: 'SC' } })
  // Family 2: paid every month in Fee Management.
  const faliq = await mk('HID12', 'Faliq', { familyId: f2._id, billing: { fee: 3000, paymentMethod: 'EasyPaisa' } })
  // No family, joined August, nothing recorded → owes Aug–Nov.
  const solo = await mk('HID50', 'Solo', { billing: { fee: 10000, paymentMethod: 'Wise' }, joiningDate: new Date('2026-08-20') })
  // Joins in December — not on November's list.
  await mk('HID60', 'Future', { joiningDate: new Date('2026-12-01'), billing: { fee: 8000 } })
  // Left — never listed.
  await mk('HID70', 'Gone', { status: 'left' })
  // Pays by 2CO (card subscription) → always at the bottom; quarterly → after the monthly families.
  const card = await mk('HID05', 'Card Payer', { billing: { fee: 6000, paymentMethod: '2CO' } })
  const quarterly = await mk('HID08', 'Quarterly', { billing: { fee: 6000, paymentMethod: 'SC', cycle: 'quarterly' } })
  // Family 3: everything settled (Nov waived) → nothing due, not listed.
  const settled = await mk('HID80', 'Settled', { familyId: f3._id, billing: { fee: 9000 } })

  const cell = (s, month, extra) => StudentFeeRecord.create({ studentId: s._id, familyId: s.familyId, year: 2026, month, ...extra })
  for (let m = 1; m <= 9; m++) await cell(zara, m, { amountPaid: 7000, status: 'received' })
  await cell(zara, 10, { amount: 0, status: 'pending' })
  await cell(ali, 10, { status: 'waived', note: 'NSY' })
  for (let m = 1; m <= 11; m++) await cell(faliq, m, { amountPaid: 3000, status: 'received' })
  for (let m = 1; m <= 10; m++) await cell(settled, m, { amountPaid: 9000, status: 'received' })
  await cell(settled, 11, { status: 'waived' })
  // 2025 has no records at all: it must not count (the window starts in January 2026).
  const feeCells = await StudentFeeRecord.countDocuments()
  const feePayments = await FeePayment.countDocuments()

  console.log('\nAccess')
  ok((await call(admin, 'GET', `/?${NOV}`)).status === 403, 'admin (no fee.tracker) is refused')
  ok((await call(tutor, 'GET', `/?${NOV}`)).status === 403, 'tutor is refused')
  ok((await call(boss, 'GET', '/?year=2026&month=13')).status === 400, 'an invalid month is refused')

  console.log('\nThe November board')
  let b = await board(boss)
  ok(b.rows.length === 5, 'five rows: family 1, family 2, the solo student, the quarterly and the 2CO payer', b.rows.map(r => r.lead.rollNo))
  ok(b.rows.map(r => r.lead.rollNo).join() === 'HID12,HID30,HID50,HID08,HID05', 'monthly families first by roll number, then other cycles, 2CO at the bottom', b.rows.map(r => r.lead.rollNo))
  ok(!rowOf(b, 'HID60') && !rowOf(b, 'HID70') && !rowOf(b, 'HID80'), 'not-yet-joined, left and fully-settled students are off the list')

  let r1 = rowOf(b, 'HID30')
  ok(r1.members.length === 2 && r1.members[0].rollNo === 'HID30', 'one row for the family, both children on it')
  ok(r1.key === `f:${f1._id}` && r1.familyCode === 'FAM-1' && r1.guardian === 'Mrs Tahir', 'row carries the family code and guardian')
  ok(r1.anyOnLeave && !r1.allOnLeave, 'the on-leave sibling stays on the list and is flagged')
  const zp = r1.members.find(m => m.rollNo === 'HID30')
  ok(zp.owed.map(o => o.month).join() === '10,11' && zp.owedTotal === 14000, 'Zara owes October (pending, base fee) and November', zp.owed)
  const ap = r1.members.find(m => m.rollNo === 'HID31')
  ok(ap.owed.map(o => o.month).join() === '11' && ap.owedTotal === 5000, 'Ali owes November only (October waived NSY)', ap.owed)
  ok(r1.owedTotal === 19000 && r1.expected === null, 'expected is manual: empty until the office types it (owed shown separately)')
  ok(r1.state === 'due' && !r1.linkSent, 'not reminded yet → due')
  ok(r1.mode === 'SC' && r1.monthlyFee === 12000, 'mode and monthly fee from the students')

  const r2 = rowOf(b, 'HID12')
  ok(r2.state === 'received' && r2.receivedFrom === 'portal', 'paid in Fee Management → received (portal)')
  ok(r2.portalPaid[0]?.amount === 3000, 'shows the amount Fee Management holds for the month')

  const rs = rowOf(b, 'HID50')
  ok(rs.key === `s:${solo._id}` && rs.familyCode === '', 'a student with no family is a row of their own')
  ok(rs.owedTotal === 40000 && rs.members[0].owed.length === 4, 'solo owes Aug–Nov (from joining)')
  ok(b.summary.due === 4 && b.summary.sent === 0 && b.summary.received === 1, 'summary counts', b.summary)
  ok(b.summary.expected === 0 && b.summary.expectedTyped === 0, 'nothing typed → expected total 0', b.summary.expected)
  ok(b.summary.owed === 19000 + 40000 + 66000 + 66000, 'what the portal says is owed is reported separately', b.summary.owed)
  ok(b.summary.portalAmounts[0]?.amount === 3000, 'Fee Management money for the month is reported separately')
  ok(b.modes.includes('SC') && b.modes.includes('Wise'), 'modes for the receipt form')

  console.log('\nYear view')
  ok(b.columns.length === 12 && b.columns[0].month === 1 && b.columns[11].month === 12 && b.columns[11].year === 2026, 'November shows January–December, like the sheet')
  const zy = rowOf(b, 'HID30').members.find(m => m.rollNo === 'HID30').year
  ok(zy[0].state === 'paid' && zy[0].amount === 7000, 'Zara January: paid in Fee Management')
  ok(zy[9].state === 'owed' && zy[9].amount === 7000 && zy[10].state === 'owed', 'Zara October and November: unpaid amounts')
  ok(zy[11].state === 'future', 'December is still to come')
  const ay = rowOf(b, 'HID30').members.find(m => m.rollNo === 'HID31').year
  ok(ay.slice(0, 9).every(c => c.state === 'nsy'), 'Ali: NSY before he joined (Jan–Sep)')
  ok(ay[9].state === 'waived' && ay[9].note === 'NSY', "Ali October: Fee Management's waived NSY note")
  ok(ay[10].state === 'owed' && ay[10].amount === 5000, 'Ali November: unpaid')
  const jan27 = await board(boss, 'year=2027&month=1')
  ok(jan27.columns[0].year === 2026 && jan27.columns[0].month === 3 && jan27.columns[11].year === 2027 && jan27.columns[11].month === 2, 'January 2027 shows March 2026 – February 2027')

  console.log('\nLink sent, expected, ignore')
  let res = await call(boss, 'PATCH', '/entry', { year: 2026, month: 11, groupKey: r1.key, linkSent: true })
  ok(res.status === 200 && res.data.linkSent && res.data.linkSentAt, 'tick link sent')
  res = await call(boss, 'PATCH', '/entry', { year: 2026, month: 11, groupKey: r1.key, expected: 18000 })
  ok(res.status === 200 && res.data.expected === 18000 && res.data.linkSent, 'type over the expected amount (link sent kept)')
  b = await board(boss)
  r1 = rowOf(b, 'HID30')
  ok(r1.state === 'sent' && r1.expected === 18000, 'row is now "link sent" with the typed amount')
  ok(b.summary.expected === 18000 && b.summary.expectedTyped === 1, 'expected total = what was typed')
  res = await call(boss, 'PATCH', '/entry', { year: 2026, month: 11, groupKey: r1.key, expected: null })
  ok(res.data.expected === null, 'expected can be reset')
  ok((await call(boss, 'PATCH', '/entry', { year: 2026, month: 11, groupKey: r1.key, expected: -5 })).status === 400, 'negative expected refused')
  ok((await call(boss, 'PATCH', '/entry', { year: 2026, month: 11, groupKey: 'x:123' })).status === 400, 'unknown row key refused')
  ok((await call(boss, 'PATCH', '/entry', { year: 2026, month: 11, groupKey: `f:${new mongoose.Types.ObjectId()}` })).status === 404, 'a family that does not exist is refused')
  ok((await call(admin, 'PATCH', '/entry', { year: 2026, month: 11, groupKey: r1.key, linkSent: false })).status === 403, 'admin cannot change rows')

  await call(boss, 'PATCH', '/entry', { year: 2026, month: 11, groupKey: rs.key, ignored: true })
  b = await board(boss)
  ok(rowOf(b, 'HID50').ignored && b.summary.ignored === 1, 'ignored for the month')
  ok(b.summary.due === 2 && b.summary.sent === 1 && b.summary.owed === 19000 + 66000 + 66000, 'ignored rows leave the totals', b.summary)
  await call(boss, 'PATCH', '/entry', { year: 2026, month: 11, groupKey: rs.key, ignored: false })

  console.log('\nMark received')
  const bad = (body) => call(boss, 'POST', '/receipts', { year: 2026, month: 11, groupKey: r1.key, currency: 'PKR', ...body })
  ok((await bad({ lines: [] })).status === 400, 'no students → refused')
  ok((await bad({ lines: [{ studentId: zara._id, months: [], amount: 1 }] })).status === 400, 'a student with no months → refused')
  ok((await bad({ lines: [{ studentId: zara._id, months: [{ year: 2026, month: 13 }], amount: 1 }] })).status === 400, 'an invalid month → refused')
  ok((await bad({ lines: [{ studentId: zara._id, months: [{ year: 2026, month: 11 }], amount: 1 }, { studentId: zara._id, months: [{ year: 2026, month: 10 }], amount: 1 }] })).status === 400, 'the same student twice → refused')
  ok((await bad({ lines: [{ studentId: zara._id, months: [{ year: 2026, month: 11 }], amount: 0 }] })).status === 400, 'nothing received → refused')
  ok((await bad({ lines: [{ studentId: new mongoose.Types.ObjectId(), months: [{ year: 2026, month: 11 }], amount: 5 }] })).status === 404, 'an unknown student → refused')

  // Family 1 pays for both children, and sends the solo student's November too.
  res = await call(boss, 'POST', '/receipts', {
    year: 2026, month: 11, groupKey: r1.key, currency: 'PKR', mode: 'SC', paidAt: '2026-11-14',
    payerName: 'Mrs Tahir', reference: 'TXN-1',
    lines: [
      { studentId: zara._id, months: [{ year: 2026, month: 11 }, { year: 2026, month: 10 }], amount: 14000 },
      { studentId: ali._id, months: [{ year: 2026, month: 11 }], amount: 5000 },
      { studentId: solo._id, months: [{ year: 2026, month: 11 }], amount: 10000 },
    ],
  })
  ok(res.status === 201, 'receipt saved', res.data)
  const rec1 = res.data
  ok(rec1.receiptNo === 'FT-2026-0001', 'numbered FT-2026-0001', rec1.receiptNo)
  ok(rec1.amount === 29000, 'amount = the lines when none is typed')
  ok(rec1.familyCode === 'FAM-1' && rec1.lines[0].name === 'Zara' && rec1.lines[0].rollNo === 'HID30', 'names and family code are snapshotted')
  ok(rec1.lines[0].months.map(m => m.month).join() === '10,11', 'months are stored in order')

  b = await board(boss)
  r1 = rowOf(b, 'HID30')
  ok(r1.state === 'received' && r1.receivedFrom === 'tracker', 'family 1 is received')
  ok(r1.owedTotal === 0 && r1.receipts[0].own && r1.receipts[0].amount === 29000, 'nothing left owing; the full payment shows on its own row')
  const rs2 = rowOf(b, 'HID50')
  ok(rs2.state === 'received' && !rs2.receipts[0].own && rs2.receipts[0].amount === 10000, "the solo student's November is settled by family 1's payment (only their share shown)")
  ok(rs2.owedTotal === 30000, 'the solo student still owes Aug–Oct', rs2.owedTotal)
  ok(b.summary.receivedAmounts.length === 1 && b.summary.receivedAmounts[0].amount === 29000, 'received total counts the payment once')
  const zy2 = rowOf(b, 'HID30').members.find(m => m.rollNo === 'HID30').year
  ok(zy2[9].state === 'tracker' && zy2[10].state === 'tracker', 'year view: the months the receipt covers show as received on the tracker')

  res = await call(boss, 'GET', `/student/${solo._id}?${NOV}`)
  ok(res.status === 200 && res.data.member.owed.map(o => o.month).join() === '8,9,10', 'a student\'s unpaid months for "Add another student"', res.data?.member?.owed)
  ok(res.data.groupKey === `s:${solo._id}`, 'with their own row key')
  ok((await call(boss, 'GET', `/student/nope?${NOV}`)).status === 404, 'unknown student id → 404')

  // Family 2 pays December in advance from November's board.
  res = await call(boss, 'POST', '/receipts', {
    year: 2026, month: 11, groupKey: r2.key, currency: 'GBP', mode: 'Wise',
    lines: [{ studentId: faliq._id, months: [{ year: 2026, month: 12 }], amount: 30 }],
  })
  ok(res.status === 201 && res.data.receiptNo === 'FT-2026-0002' && res.data.currency === 'GBP', 'second receipt numbered 0002, in its own currency')
  b = await board(boss)
  ok(b.summary.receivedAmounts.length === 2, 'received totals are per currency, never summed across', b.summary.receivedAmounts)

  res = await call(boss, 'GET', `/receipts?${NOV}`)
  ok(res.status === 200 && res.data.records.length === 2, 'list of the month\'s receipts')
  ok((await call(boss, 'GET', `/receipts/${rec1._id}`)).data.receiptNo === 'FT-2026-0001', 'read one receipt back to reprint it')

  console.log('\nDetail page')
  await call(boss, 'PATCH', '/entry', { year: 2026, month: 11, groupKey: r1.key, note: 'Mother asked for the link on WhatsApp' })
  res = await call(boss, 'GET', `/rows/${r1.key}?${NOV}`)
  let d = res.data
  ok(res.status === 200 && d.groupKey === r1.key && d.family.familyCode === 'FAM-1' && d.family.guardian === 'Mrs Tahir', "a family's record opens with its code and guardian")
  ok(d.members.length === 2 && d.row?.state === 'received' && d.row.owedTotal === 0, 'same row as the board: both children, received this month')
  ok(d.columns.length === 12 && d.months.length === 12 && d.members[0].year.length === 12, 'a year of months, matching the year view')
  const novM = d.months.find(m => m.year === 2026 && m.month === 11)
  ok(novM.linkSent && novM.linkSentAt && novM.note === 'Mother asked for the link on WhatsApp', "November's link-sent time and note are on the record")
  ok(d.receipts.length === 1 && d.receipts[0].receiptNo === 'FT-2026-0001' && d.receipts[0].own && d.receipts[0].share === 29000, "the family's own receipt, in full")
  ok(d.receipts[0].recordedBy === 'Boss Owner', 'with who marked it')
  ok(d.activity.some(a => a.kind === 'link') && d.activity.some(a => a.kind === 'receipt') && d.activity.some(a => a.kind === 'note'), 'activity: link sent, note and payment')
  ok(d.totals.received.length === 1 && d.totals.received[0].amount === 29000 && d.totals.receipts === 1, 'lifetime received on the tracker')
  res = await call(boss, 'GET', `/rows/s:${zara._id}?${NOV}`)
  ok(res.status === 200 && res.data.groupKey === r1.key && res.data.focus === String(zara._id), "a child's own link opens the family's record, focused on that child")
  res = await call(boss, 'GET', `/rows/s:${solo._id}?${NOV}`)
  d = res.data
  ok(res.status === 200 && !d.family && d.members.length === 1 && d.members[0].owedTotal === 30000, 'a solo student opens on their own, still owing Aug–Oct')
  ok(d.receipts.length === 1 && !d.receipts[0].own && d.receipts[0].share === 10000 && d.receipts[0].lines.length === 1 && d.receipts[0].otherLines === 2,
    "another family's payment shows only this student's share and line")
  res = await call(boss, 'GET', `/rows/f:${f3._id}?${NOV}`)
  ok(res.status === 200 && res.data.row === null && res.data.members.length === 1, 'a settled family still opens (nothing due this month)')
  ok((await call(boss, 'GET', `/rows/f:${new mongoose.Types.ObjectId()}?${NOV}`)).status === 404, 'an unknown family → 404')
  ok((await call(boss, 'GET', `/rows/nope?${NOV}`)).status === 404, 'a malformed key → 404')
  ok((await call(admin, 'GET', `/rows/${r1.key}?${NOV}`)).status === 403, 'admin cannot open a record')

  console.log('\nFee Management is untouched')
  ok(await StudentFeeRecord.countDocuments() === feeCells, 'no fee records written')
  ok(await FeePayment.countDocuments() === feePayments, 'no fee payments written')
  const zaraOct = await StudentFeeRecord.findOne({ studentId: zara._id, year: 2026, month: 10 }).lean()
  ok(zaraOct.status === 'pending' && zaraOct.amountPaid === 0, "Zara's October is still pending in Fee Management")

  console.log('\nNext month starts clean')
  const dec = await board(boss, 'year=2026&month=12')
  const d1 = rowOf(dec, 'HID30')
  ok(d1 && d1.state === 'due' && !d1.linkSent, 'December: family 1 is due again with "link sent" cleared')
  ok(d1.owedTotal === 12000, 'December owes only December (Oct/Nov covered by the receipt)', d1.owedTotal)
  ok(rowOf(dec, 'HID12')?.state === 'received', 'family 2\'s December, paid in advance, shows received')
  ok(rowOf(dec, 'HID60'), 'the December joiner appears in December')

  console.log('\nUndo')
  ok((await call(admin, 'DELETE', `/receipts/${rec1._id}`)).status === 403, 'admin cannot delete a receipt')
  ok((await call(boss, 'DELETE', `/receipts/${rec1._id}`)).status === 200, 'remove the receipt')
  b = await board(boss)
  r1 = rowOf(b, 'HID30')
  ok(r1.state === 'sent' && r1.owedTotal === 19000, 'family 1 is back to "link sent" and owing')
  ok(rowOf(b, 'HID50').owedTotal === 40000, 'the solo student owes November again')
  ok((await call(boss, 'DELETE', `/receipts/${rec1._id}`)).status === 404, 'deleting twice → 404')

  // A deleted receipt's number may already be with a parent: never reuse it.
  const last = (await call(boss, 'GET', `/receipts?${NOV}`)).data.records.find(r => r.receiptNo === 'FT-2026-0002')
  ok((await call(boss, 'DELETE', `/receipts/${last._id}`)).status === 200, 'remove the newest receipt (0002)')
  res = await call(boss, 'POST', '/receipts', {
    year: 2026, month: 11, groupKey: r2.key, currency: 'GBP',
    lines: [{ studentId: faliq._id, months: [{ year: 2026, month: 12 }], amount: 30 }],
  })
  ok(res.status === 201 && res.data.receiptNo === 'FT-2026-0003', 'the next receipt is 0003, not the deleted 0002', res.data?.receiptNo)

  // The office records rupees; the receipt shows each student's own currency.
  console.log('\nReceipt in the student\'s currency')
  const usd = await mk('HID90', 'Dollar Kid', { billing: { fee: 11091, amount: 40, currency: 'USD', paymentMethod: '3rd PARTY' } })
  res = await call(boss, 'POST', '/receipts', {
    year: 2026, month: 11, groupKey: `s:${usd._id}`, currency: 'PKR',
    lines: [
      { studentId: usd._id, months: [{ year: 2026, month: 10 }, { year: 2026, month: 11 }], amount: 22182 },
      { studentId: solo._id, months: [{ year: 2026, month: 12 }], amount: 10000 },
    ],
  })
  const conv = res.data
  ok(res.status === 201 && conv.currency === 'PKR' && conv.amount === 32182, 'recorded in rupees', conv)
  ok(conv.lines[0].billedCurrency === 'USD' && conv.lines[0].billedAmount === 80, 'a USD 40 student\'s PKR 22,182 prints as USD 80', conv.lines[0])
  ok(conv.lines[1].billedCurrency === 'PKR' && conv.lines[1].billedAmount === 10000, 'a rupee-billed student stays in PKR', conv.lines[1])
  await FeeTrackerReceipt.updateOne({ _id: conv._id }, { $unset: { 'lines.$[].billedCurrency': 1, 'lines.$[].billedAmount': 1 } })
  res = await call(boss, 'GET', `/receipts/${conv._id}`)
  ok(res.data.lines[0].billedCurrency === 'USD' && res.data.lines[0].billedAmount === 80, 'an older receipt is worked out from the student\'s billing when read', res.data.lines[0])
  res = await call(boss, 'GET', `/receipts?${NOV}`)
  ok(res.data.records.find(r => String(r._id) === String(conv._id))?.lines[0].billedCurrency === 'USD', 'and in the receipts list')
  const gbp = res.data.records.find(r => r.currency === 'GBP')
  ok(gbp.lines.every(l => l.billedCurrency === 'GBP' && l.billedAmount === l.amount), 'a receipt recorded in GBP stays as recorded')
} catch (err) {
  fail++
  console.error('Smoke crashed:', err)
} finally {
  server.close()
  await mongoose.connection.dropDatabase()
  await mongoose.disconnect()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

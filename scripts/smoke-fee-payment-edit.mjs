// Smoke test for editing a Fee Management payment (PUT /portal/fees/payments/:id).
//
//   - the SAME payment is changed — the log never shows the old and the new one
//   - a month taken off the payment stops showing it as paid: its money, its
//     payment link, its method/date, and the cell itself if the payment made it
//   - the grid, the payments log, the student's history and the Fee Tracker's
//     source (StudentFeeRecord) all agree after the edit
//   - an amount typed into a cell by hand survives an edit that doesn't touch it
//   - moving a payment to another student, two payments on one month, waived months
//   - a double save can't roll the old months back twice (409), nor a double delete
//
// Runs against a THROWAWAY database (dbName hidaya_fee_edit_smoke) on the same
// cluster and drops it at the end. Controllers are called directly — no server.
// Run: node scripts/smoke-fee-payment-edit.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import Student from '../models/Student.js'
import StudentFeeRecord from '../models/StudentFeeRecord.js'
import FeePayment from '../models/FeePayment.js'
import Payment from '../models/Payment.js'
import '../models/User.js'
import '../models/Family.js'
import {
  getFeeGrid, upsertFeeCell, createFeePayment, listFeePayments, updateFeePayment,
  deleteFeePayment, getStudentFeeHistory,
} from '../controllers/portalFeeController.js'

let pass = 0, fail = 0
const ok = (c, m, detail = '') => {
  if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m, detail) }
}

const SMOKE_DB = 'hidaya_fee_edit_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB, serverSelectionTimeoutMS: 15000 })
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
await mongoose.connection.dropDatabase()
await Promise.all([StudentFeeRecord.init(), FeePayment.init()])

const userId = new mongoose.Types.ObjectId()
async function call(fn, { body = {}, query = {}, params = {} } = {}) {
  const res = { status: 200, data: null }
  res.status = (c) => { res._status = c; return res }
  res.json = (d) => { res.data = d; return res }
  await fn({ userId, body, query, params, ip: '127.0.0.1', headers: {}, get: () => '' }, res)
  return { status: res._status || 200, data: res.data }
}
const cell = (s, month, year = YEAR) => StudentFeeRecord.findOne({ studentId: s._id, year, month }).lean()
const YEAR = 2025 // a past year, so every month is due and empty months auto-bill

try {
  const A = await Student.create({ name: 'Edit Smoke A', rollNo: 'EDS-A', status: 'active', billing: { fee: 3000, currency: 'PKR' }, joiningDate: new Date('2024-01-01') })
  const B = await Student.create({ name: 'Edit Smoke B', rollNo: 'EDS-B', status: 'active', billing: { fee: 3000, currency: 'PKR' }, joiningDate: new Date('2024-01-01') })

  console.log('\nSet up: Jan has an agreed fee, Feb has no record')
  await call(upsertFeeCell, { body: { studentId: String(A._id), year: YEAR, month: 1, amount: 3000 } })
  let r = await call(createFeePayment, { body: {
    amount: 6000, currency: 'PKR', method: 'cash', payerName: 'Dawood', paidAt: '2025-02-03',
    allocations: [
      { studentId: String(A._id), year: YEAR, month: 1, amount: 3000 },
      { studentId: String(A._id), year: YEAR, month: 2, amount: 3000 },
    ],
  } })
  ok(r.status === 201, 'payment logged')
  const P = r.data._id
  ok((await cell(A, 1))?.status === 'received' && (await cell(A, 2))?.status === 'received', 'Jan and Feb received')

  console.log('\nEdit: Feb was a mistake — it was for March, and Jan was 2000')
  r = await call(updateFeePayment, { params: { id: P }, body: {
    amount: 5000, currency: 'PKR', method: 'bank_transfer', payerName: 'Dawood Sb', reference: 'TXN-9',
    allocations: [
      { studentId: String(A._id), year: YEAR, month: 1, amount: 2000 },
      { studentId: String(A._id), year: YEAR, month: 3, amount: 3000 },
    ],
  } })
  ok(r.status === 200, 'edit saved', JSON.stringify(r.data))
  ok(String(r.data?._id) === String(P) && r.data?.amount === 5000 && r.data?.payerName === 'Dawood Sb', 'the same payment comes back, changed')
  ok(r.data?.allocations?.[0]?.studentId?.name === 'Edit Smoke A', 'response is populated like the log')
  ok(await FeePayment.countDocuments() === 1, 'still ONE payment — no copy left behind')
  const jan = await cell(A, 1)
  ok(jan.amountPaid === 2000 && jan.status === 'partial', 'Jan now partial (2000 of 3000)', JSON.stringify(jan))
  ok(jan.method === 'bank_transfer', 'Jan shows the edited method')
  ok(!(await cell(A, 2)), 'Feb record is gone (the payment had made it) — not left behind as paid')
  const mar = await cell(A, 3)
  ok(mar?.amountPaid === 3000 && mar.status === 'received' && mar.payments.map(String).includes(String(P)), 'Mar received from the payment')

  r = await call(getFeeGrid, { query: { year: YEAR, search: 'Edit Smoke A', limit: 'all', studentStatus: 'all' } })
  const gA = r.data.records.find(x => String(x._id) === String(A._id))
  ok(!gA.months[2] && gA.autoMonths.includes(2), 'grid: Feb is back to auto-billed (due), not paid')
  ok(gA.months[3]?.status === 'received' && gA.months[1]?.status === 'partial', 'grid: Jan partial, Mar received')

  r = await call(listFeePayments, { query: { year: YEAR, fromMonth: 2, toMonth: 2 } })
  ok(r.data.total === 0, 'payments log for Feb is empty')
  r = await call(listFeePayments, { query: { year: YEAR, fromMonth: 3, toMonth: 3 } })
  ok(r.data.total === 1 && r.data.records[0].amount === 5000, 'payments log for Mar shows the edited payment once')

  r = await call(getStudentFeeHistory, { params: { studentId: String(A._id) } })
  const hFeb = r.data.months.find(m => m.year === YEAR && m.month === 2)
  ok(hFeb && hFeb.auto && hFeb.amountPaid === 0 && hFeb.payments.length === 0, 'history: Feb unpaid, no payment on it')
  ok(r.data.payments.length === 1 && r.data.payments[0].allocatedToStudent === 5000, 'history: one payment, 5000 to this student')

  console.log('\nMove the payment to the right student')
  r = await call(updateFeePayment, { params: { id: P }, body: {
    amount: 5000, allocations: [
      { studentId: String(A._id), year: YEAR, month: 1, amount: 2000 },
      { studentId: String(B._id), year: YEAR, month: 3, amount: 3000 },
    ],
  } })
  ok(r.status === 200, 'edit saved')
  ok(!(await cell(A, 3)), "A's March is no longer paid (record removed)")
  ok((await cell(B, 3))?.status === 'received', "B's March is received")
  ok((await FeePayment.findById(P).lean()).method === 'bank_transfer', 'fields not sent are kept')

  console.log('\nA hand-typed amount survives an edit that does not touch its month')
  r = await call(createFeePayment, { body: { amount: 3000, allocations: [{ studentId: String(A._id), year: YEAR, month: 4, amount: 3000 }] } })
  const Q = r.data._id
  await call(upsertFeeCell, { body: { studentId: String(A._id), year: YEAR, month: 4, amount: 3000, amountPaid: 500 } })
  r = await call(updateFeePayment, { params: { id: Q }, body: { amount: 3000, payerName: 'Renamed', allocations: [{ studentId: String(A._id), year: YEAR, month: 4, amount: 3000 }] } })
  ok(r.status === 200 && (await cell(A, 4)).amountPaid === 500, 'April keeps the 500 typed by hand')

  console.log('\nTwo payments on one month')
  r = await call(createFeePayment, { body: { amount: 1000, method: 'cash', paidAt: '2025-05-02', allocations: [{ studentId: String(B._id), year: YEAR, month: 5, amount: 1000 }] } })
  const P2 = r.data._id
  r = await call(createFeePayment, { body: { amount: 2000, method: 'jazzcash', paidAt: '2025-05-20', allocations: [{ studentId: String(B._id), year: YEAR, month: 5, amount: 2000 }] } })
  const P3 = r.data._id
  let may = await cell(B, 5)
  ok(may.amountPaid === 3000 && may.method === 'jazzcash', 'May: 3000 from two payments')
  r = await call(updateFeePayment, { params: { id: P3 }, body: { amount: 2000, allocations: [{ studentId: String(B._id), year: YEAR, month: 6, amount: 2000 }] } })
  may = await cell(B, 5)
  ok(may.amountPaid === 1000 && may.status === 'received' && may.payments.map(String).join() === String(P2), 'May keeps only the other payment', JSON.stringify(may))
  ok(may.method === 'cash' && new Date(may.paidAt).toISOString().startsWith('2025-05-02'), "May's method/date come from the payment still on it")

  console.log('\nWaived months stay waived')
  await call(upsertFeeCell, { body: { studentId: String(B._id), year: YEAR, month: 7, status: 'waived', note: 'DA' } })
  r = await call(createFeePayment, { body: { amount: 500, allocations: [{ studentId: String(B._id), year: YEAR, month: 7, amount: 500 }] } })
  const W = r.data._id
  ok((await cell(B, 7)).status === 'waived', 'waived with money on it')
  await call(updateFeePayment, { params: { id: W }, body: { amount: 500, allocations: [{ studentId: String(B._id), year: YEAR, month: 8, amount: 500 }] } })
  const jul = await cell(B, 7)
  ok(jul && jul.status === 'waived' && jul.amountPaid === 0 && jul.note === 'DA', 'July still waived, note kept, money moved')

  console.log('\nDouble save / double delete')
  const body = { amount: 3000, allocations: [{ studentId: String(A._id), year: YEAR, month: 9, amount: 3000 }] }
  r = await call(createFeePayment, { body })
  const D = r.data._id
  const edit = { amount: 4000, allocations: [{ studentId: String(A._id), year: YEAR, month: 10, amount: 4000 }] }
  const both = await Promise.all([
    call(updateFeePayment, { params: { id: D }, body: edit }),
    call(updateFeePayment, { params: { id: D }, body: edit }),
  ])
  const codes = both.map(x => x.status).sort()
  ok(codes.join() === '200,409', 'two saves at once: one wins, the other gets 409', codes.join())
  ok(!(await cell(A, 9)) && (await cell(A, 10)).amountPaid === 4000, 'Sep cleared, Oct 4000 — not counted twice')
  const dels = await Promise.all([
    call(deleteFeePayment, { params: { id: D } }),
    call(deleteFeePayment, { params: { id: D } }),
  ])
  ok(dels.map(x => x.status).sort().join() === '200,404', 'two deletes at once: 200 and 404')
  ok(!(await cell(A, 10)), 'Oct rolled back once, record gone')

  console.log('\nDelete keeps an agreed fee, drops only what the payment made')
  r = await call(deleteFeePayment, { params: { id: P } })
  ok(r.status === 200, 'payment removed')
  const jan2 = await cell(A, 1)
  ok(jan2 && jan2.amount === 3000 && jan2.amountPaid === 0 && jan2.status === 'pending' && !jan2.paidAt && !jan2.method, 'Jan back to an unpaid 3000')
  ok(!(await cell(B, 3)), "B's March record (made by the payment) is gone")

  console.log('\nValidation')
  ok((await call(updateFeePayment, { params: { id: Q }, body: { amount: 3000, allocations: [] } })).status === 400, 'no months → 400')
  ok((await call(updateFeePayment, { params: { id: Q }, body: { amount: 0, allocations: body.allocations } })).status === 400, 'zero amount → 400')
  ok((await call(updateFeePayment, { params: { id: Q }, body: { amount: 10, currency: 'XYZ', allocations: body.allocations } })).status === 400, 'unknown currency → 400')
  ok((await call(updateFeePayment, { params: { id: Q }, body: { amount: 10, paidAt: 'not a date', allocations: body.allocations } })).status === 400, 'bad date → 400')
  ok((await call(updateFeePayment, { params: { id: String(new mongoose.Types.ObjectId()) }, body })).status === 404, 'unknown payment → 404')
  ok((await cell(A, 4)).amountPaid === 500, 'refused edits changed nothing')

  console.log('\nGateway link')
  const gw = await Payment.create({ studentName: 'GW', studentEmail: 'gw@x.test', plan: 'Smoke', amount: 50, currency: 'USD', status: 'completed' }).catch(e => ({ err: e }))
  if (gw.err) {
    console.log('  (skipped: could not create a gateway Payment —', gw.err.message, ')')
  } else {
    r = await call(createFeePayment, { body: { amount: 50, currency: 'USD', linkedPaymentId: String(gw._id), allocations: [{ studentId: String(B._id), year: YEAR, month: 11, amount: 50 }] } })
    ok(r.status === 201, 'linked payment logged')
    r = await call(updateFeePayment, { params: { id: Q }, body: { amount: 3000, linkedPaymentId: String(gw._id), allocations: [{ studentId: String(A._id), year: YEAR, month: 4, amount: 3000 }] } })
    ok(r.status === 400, 'cannot link a gateway payment that another fee record has')
  }
} catch (err) {
  fail++
  console.error('Smoke crashed:', err)
} finally {
  await mongoose.connection.dropDatabase()
  await mongoose.disconnect()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

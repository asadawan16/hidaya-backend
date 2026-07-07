// Smoke test for Fee Management.
// Verifies: cell upsert, one payment allocated across multiple months &
// multiple students (family), status computation, grid read, and rollback on
// delete. Creates temp students, cleans up. Run: node scripts/smoke-fees.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import Student from '../models/Student.js'
import StudentFeeRecord from '../models/StudentFeeRecord.js'
import FeePayment from '../models/FeePayment.js'
import '../models/User.js' // register schema for populate() in listFeePayments
import '../models/Family.js'
import '../models/Payment.js'
import {
  getFeeGrid, upsertFeeCell, createFeePayment, listFeePayments, deleteFeePayment,
} from '../controllers/portalFeeController.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }
function mockRes() {
  const res = { _status: 200, _json: null }
  res.status = (c) => { res._status = c; return res }
  res.json = (d) => { res._json = d; return res }
  return res
}
const req = (body = {}, query = {}, params = {}) => ({ userId: new mongoose.Types.ObjectId(), body, query, params })
const YEAR = 2099 // isolated test year

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
  console.log('Connected. Creating temp students…')
  const s1 = await Student.create({ name: 'SMOKE Fee A', rollNo: 'SMOKE-FEE-A', status: 'active' })
  const s2 = await Student.create({ name: 'SMOKE Fee B', rollNo: 'SMOKE-FEE-B', status: 'active' })

  try {
    // 1) Set an agreed amount on a cell (pending, unpaid)
    let res = mockRes()
    await upsertFeeCell(req({ studentId: String(s1._id), year: YEAR, month: 1, amount: 3000 }), res)
    ok(res._json?.status === 'pending' && res._json.amount === 3000, 'cell with amount but no payment is pending')

    // 2) One payment: 9000 covering Jan/Feb/Mar for s1 AND Jan for s2 (family-style)
    res = mockRes()
    await createFeePayment(req({
      amount: 12000, currency: 'PKR', method: 'bank_transfer', reference: 'TXN-SMOKE',
      allocations: [
        { studentId: String(s1._id), year: YEAR, month: 1, amount: 3000 },
        { studentId: String(s1._id), year: YEAR, month: 2, amount: 3000 },
        { studentId: String(s1._id), year: YEAR, month: 3, amount: 3000 },
        { studentId: String(s2._id), year: YEAR, month: 1, amount: 3000 },
      ],
    }), res)
    ok(res._status === 201, 'createFeePayment returns 201')
    const paymentId = res._json._id

    // 3) s1 Jan now received (3000 paid against 3000 expected)
    const jan1 = await StudentFeeRecord.findOne({ studentId: s1._id, year: YEAR, month: 1 }).lean()
    ok(jan1?.status === 'received' && jan1.amountPaid === 3000, 's1 Jan marked received after payment')
    const mar1 = await StudentFeeRecord.findOne({ studentId: s1._id, year: YEAR, month: 3 }).lean()
    ok(mar1?.status === 'received', 's1 Mar (auto-created by allocation) received')
    const jan2 = await StudentFeeRecord.findOne({ studentId: s2._id, year: YEAR, month: 1 }).lean()
    ok(jan2?.status === 'received' && jan2.amountPaid === 3000, 's2 Jan received (one payment covered two students)')

    // 4) Grid reflects the cells
    res = mockRes()
    await getFeeGrid(req({}, { year: YEAR, search: 'SMOKE Fee', limit: 50 }), res)
    const gridS1 = res._json.records.find(r => String(r._id) === String(s1._id))
    ok(gridS1 && gridS1.months[1]?.status === 'received' && gridS1.months[2]?.status === 'received', 'grid shows s1 Jan+Feb received')

    // 5) Partial: pay 1000 of a 3000 month
    res = mockRes()
    await upsertFeeCell(req({ studentId: String(s2._id), year: YEAR, month: 2, amount: 3000, amountPaid: 1000 }), res)
    ok(res._json.status === 'partial', 'cell with amountPaid < amount is partial')

    // 6) Waived override sticks
    res = mockRes()
    await upsertFeeCell(req({ studentId: String(s2._id), year: YEAR, month: 3, status: 'waived' }), res)
    ok(res._json.status === 'waived', 'explicit waived status is honored')

    // 7) List payments includes ours
    res = mockRes()
    await listFeePayments(req({}, { studentId: String(s1._id) }), res)
    ok(res._json.records.some(p => String(p._id) === String(paymentId)), 'listFeePayments returns the payment for the student')

    // 8) Delete payment rolls back the cells
    res = mockRes()
    await deleteFeePayment(req({}, {}, { id: String(paymentId) }), res)
    const jan1After = await StudentFeeRecord.findOne({ studentId: s1._id, year: YEAR, month: 1 }).lean()
    ok(jan1After.amountPaid === 0 && jan1After.status === 'pending', 's1 Jan rolled back to pending after payment delete')
    const jan2After = await StudentFeeRecord.findOne({ studentId: s2._id, year: YEAR, month: 1 }).lean()
    ok(jan2After.amountPaid === 0 && jan2After.status === 'pending', 's2 Jan rolled back to pending')
  } finally {
    await StudentFeeRecord.deleteMany({ studentId: { $in: [s1._id, s2._id] } })
    await FeePayment.deleteMany({ 'allocations.studentId': { $in: [s1._id, s2._id] } })
    await Student.deleteMany({ _id: { $in: [s1._id, s2._id] } })
    console.log('Cleaned up temp data.')
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  await mongoose.disconnect()
  process.exit(fail ? 1 : 0)
}
run().catch(e => { console.error('SMOKE ERROR:', e); process.exit(1) })

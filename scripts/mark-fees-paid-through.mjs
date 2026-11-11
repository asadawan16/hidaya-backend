// One-off clear-up (client's request, 2026-11-11/12): every student's months
// of a year, from January (or the month they joined, if later) up to a given
// month, show as billed and paid: their billed amount, in their billing
// currency. For each not-left student with a billed amount:
//   - a month with no saved cell gets one: fee = paid = the billed amount
//   - a saved month with nothing in it (fee 0, nothing paid) is filled the same way
//   - a saved month with a fee and something still to pay is marked paid in full
//   - months with money already in, waived months and months on leave are left alone
// Months before AUTO_BILL_FROM count too: they are history from before the
// portal, which the academy says was all paid.
//
// Each changed month gets status 'received' and a note saying it was marked
// here. No FeePayment is created: the money came in
// before it was logged, so Revenue (which reads the Payments Log) is not
// inflated. Note: "Reset" on such a month rebuilds it from the Payments Log
// and so undoes the mark.
//
// Dry run by default. --apply writes, after saving every cell it will change
// to ../backups/fees-before-mark-paid-<year>-<date>.json.
//
//   node scripts/mark-fees-paid-through.mjs --year 2026 --to 10           # dry run
//   node scripts/mark-fees-paid-through.mjs --year 2026 --to 10 --apply   # write
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import mongoose from 'mongoose'
import Student from '../models/Student.js'
import StudentFeeRecord from '../models/StudentFeeRecord.js'
import { monthlyFee, karachiToday } from '../utils/feeDue.js'
import { dueDayOf, dueDateIn, isoDate } from '../utils/feeDue.js'
import { isOnLeaveOn } from '../utils/studentLeave.js'

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined }
const APPLY = process.argv.includes('--apply')
const YEAR = parseInt(arg('--year'), 10)
const TO = parseInt(arg('--to'), 10)
if (!YEAR || !(TO >= 1 && TO <= 12)) {
  console.error('Usage: node scripts/mark-fees-paid-through.mjs --year 2026 --to 10 [--apply]')
  process.exit(1)
}

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected to db "${mongoose.connection.name}" on ${mongoose.connection.host}. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}`)
console.log(`Marking Jan–${TO}/${YEAR} as paid.\n`)

const today = karachiToday()
const NOTE = `Marked paid in the Jan–${TO}/${YEAR} clear-up (${today.iso})`
const students = await Student.find({})
  .select('name rollNo status familyId billing joiningDate createdAt leaveStartDate leaveEndDate').lean()
const cells = await StudentFeeRecord.find({ year: YEAR, month: { $lte: TO } }).lean()
const cellOf = new Map(cells.map(c => [`${c.studentId}|${c.month}`, c]))

// January, or the month they joined when that is later in YEAR (13 = joined after YEAR)
const firstMonth = (s) => {
  const jd = s.joiningDate || s.createdAt
  const d = jd ? new Date(jd) : null
  if (!d || isNaN(d.getTime())) return 1
  if (d.getUTCFullYear() > YEAR) return 13
  return d.getUTCFullYear() === YEAR ? d.getUTCMonth() + 1 : 1
}

const plan = [] // { s, month, cell?, fee, currency }
for (const s of students) {
  const fee = monthlyFee(s)
  const currency = s.billing?.currency || 'PKR'
  if (s.status === 'left' || !(fee > 0)) continue
  for (let month = firstMonth(s); month <= TO; month++) {
    const dueIso = isoDate(YEAR, month, dueDateIn(dueDayOf(s), YEAR, month))
    if (isOnLeaveOn(s, dueIso, { openFrom: today.iso })) continue
    const cell = cellOf.get(`${s._id}|${month}`)
    if (!cell) { plan.push({ s, month, cell: null, fee, currency }); continue }
    if (cell.status === 'waived') continue
    const paid = cell.amountPaid || 0
    const amount = cell.amount || 0
    if (!amount && !paid) plan.push({ s, month, cell, fee, currency })        // empty month
    else if (amount > paid) plan.push({ s, month, cell, fee: amount, currency }) // still owed
  }
}

const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
for (const p of plan) {
  const was = p.cell ? `cell ${p.cell.amountPaid || 0}/${p.cell.amount || 0} ${p.cell.status}` : 'nothing saved'
  console.log(`${APPLY ? 'MARK ' : 'WOULD'}  ${(p.s.rollNo || '').padEnd(7)} ${p.s.name.padEnd(24)} ${MON[p.month]} ${YEAR}  ${p.currency} ${p.fee}  (was ${was})`)
}
const totals = {}
for (const p of plan) totals[p.currency] = (totals[p.currency] || 0) + (p.fee - (p.cell?.amountPaid || 0))
console.log(`\n${plan.length} month(s) across ${new Set(plan.map(p => String(p.s._id))).size} student(s). Amount marked: ${Object.entries(totals).map(([c, v]) => `${c} ${v}`).join(', ') || 'nothing'}`)

if (APPLY && plan.length) {
  const dir = path.resolve(process.cwd(), '..', 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `fees-before-mark-paid-${YEAR}-${today.iso}.json`)
  fs.writeFileSync(file, JSON.stringify({
    db: mongoose.connection.name, at: new Date().toISOString(), note: NOTE,
    changedCells: plan.filter(p => p.cell).map(p => p.cell),
    createdFor: plan.filter(p => !p.cell).map(p => ({ studentId: p.s._id, year: YEAR, month: p.month })),
  }, null, 2))
  console.log(`Backup written: ${file}`)

  for (const p of plan) {
    if (p.cell) {
      await StudentFeeRecord.updateOne({ _id: p.cell._id }, {
        $set: { amount: p.fee, amountPaid: p.fee, currency: p.currency, status: 'received', paidAt: p.cell.paidAt || new Date(), note: p.cell.note ? `${p.cell.note} · ${NOTE}` : NOTE },
      })
    } else {
      await StudentFeeRecord.create({
        studentId: p.s._id, familyId: p.s.familyId, year: YEAR, month: p.month,
        amount: p.fee, amountPaid: p.fee, currency: p.currency, status: 'received', paidAt: new Date(), note: NOTE,
      })
    }
  }
  console.log('Done.')
} else if (!APPLY && plan.length) {
  console.log('Re-run with --apply to write these changes.')
}
await mongoose.disconnect()

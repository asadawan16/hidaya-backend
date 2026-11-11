// One-off clear-up (client's request, 2026-11-11): mark every fee month of a
// year up to a given month as paid. A month counts if the fee grid bills it:
// a saved cell with something still to pay (any student), or a month billed
// automatically from the monthly fee (not-left students, from AUTO_BILL_FROM
// and their joining month, not while on leave). Waived months are left alone.
//
// Each changed month gets amountPaid = its fee, status 'received' and a note
// saying it was marked here. No FeePayment is created: the money came in
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
import { AUTO_BILL_FROM, monthlyFee, karachiToday } from '../utils/feeDue.js'
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

const firstAutoMonth = (s) => {
  if (YEAR < AUTO_BILL_FROM.year) return 13
  let m = YEAR === AUTO_BILL_FROM.year ? AUTO_BILL_FROM.month : 1
  const jd = s.joiningDate || s.createdAt
  const d = jd ? new Date(jd) : null
  if (d && !isNaN(d.getTime())) {
    if (d.getUTCFullYear() > YEAR) return 13
    if (d.getUTCFullYear() === YEAR) m = Math.max(m, d.getUTCMonth() + 1)
  }
  return m
}

const plan = [] // { s, month, cell?, fee, currency, before }
for (const s of students) {
  const fee = monthlyFee(s)
  const currency = s.billing?.currency || 'PKR'
  for (let month = 1; month <= TO; month++) {
    const cell = cellOf.get(`${s._id}|${month}`)
    if (cell) {
      // A cell's own fee wins: 0 means nothing is billed that month (set by
      // hand), and a paid cell with no fee already reads as paid.
      if (cell.status === 'waived') continue
      const amount = cell.amount || 0
      if (!(amount > 0) || (cell.amountPaid || 0) >= amount) continue
      plan.push({ s, month, cell, fee: amount, currency: cell.currency || currency })
    } else if (s.status !== 'left' && fee > 0 && month >= firstAutoMonth(s)) {
      const dueIso = isoDate(YEAR, month, dueDateIn(dueDayOf(s), YEAR, month))
      if (isOnLeaveOn(s, dueIso, { openFrom: today.iso })) continue
      plan.push({ s, month, cell: null, fee, currency })
    }
  }
}

const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
for (const p of plan) {
  const was = p.cell ? `cell ${p.cell.amountPaid || 0}/${p.cell.amount || 0} ${p.cell.status}` : 'no cell (auto-billed)'
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
        $set: { amount: p.fee, amountPaid: p.fee, status: 'received', paidAt: p.cell.paidAt || new Date(), note: p.cell.note ? `${p.cell.note} · ${NOTE}` : NOTE },
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

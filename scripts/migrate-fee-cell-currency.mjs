/**
 * migrate-fee-cell-currency.mjs — realign `StudentFeeRecord.currency` with the
 * student's agreed billing currency.
 *
 * Why: until the fix in `portalFeeController.upsertFeeCell`, a fee cell created
 * through the Yearly Grid fell back to the schema default `PKR` instead of
 * inheriting `Student.billing.currency`. A student priced in USD or GBP on the
 * student detail page therefore has months stored in rupees. Totals are grouped
 * per currency and never converted, so those months read as a different (and
 * wrong) amount everywhere the ledger is shown — the portal's Fee Management,
 * the student's My Fees page, and the mobile app.
 *
 * Safety: **a cell that received money is never rewritten.** If `amountPaid > 0`
 * or a `FeePayment` is linked, the stored currency is the currency the money
 * actually arrived in — that's a fact about a receipt, not a default to correct.
 * Those are listed for manual review instead.
 *
 * Idempotent: re-running after an --apply changes nothing.
 *
 *   node scripts/migrate-fee-cell-currency.mjs                       # dry run (default)
 *   node scripts/migrate-fee-cell-currency.mjs --apply               # write the safe changes
 *   node scripts/migrate-fee-cell-currency.mjs --apply --include-paid
 *
 * `--include-paid` also rewrites cells that hold money. **Only use it on a
 * seeded dev/test database**, where those "payments" are generated fixtures
 * (seedDemo records every amount in PKR regardless of the student's currency,
 * which is why a USD student's history looks like rupees). On a real database
 * this would relabel genuine receipts as a currency they were never paid in.
 */
import 'dotenv/config'
import mongoose from 'mongoose'
import { loadAllModels } from './students-lib.mjs'

const APPLY = process.argv.includes('--apply')
const INCLUDE_PAID = process.argv.includes('--include-paid')

await mongoose.connect(process.env.MONGODB_URI)
await loadAllModels(process.cwd())

const Student = mongoose.model('Student')
const StudentFeeRecord = mongoose.model('StudentFeeRecord')

const students = await Student.find({}).select('name rollNo billing.currency').lean()
const currencyOf = new Map(
  students.map(s => [String(s._id), (s.billing?.currency || 'PKR').toUpperCase()]),
)
const labelOf = new Map(students.map(s => [String(s._id), `${s.rollNo || '—'} ${s.name}`]))

const cells = await StudentFeeRecord.find({}).lean()

const toFix = []
const skippedPaid = []
const orphans = []

for (const rec of cells) {
  const sid = String(rec.studentId)
  const want = currencyOf.get(sid)
  if (!want) {
    orphans.push(rec)
    continue
  }
  const have = (rec.currency || 'PKR').toUpperCase()
  if (have === want) continue

  const touchedByMoney = (rec.amountPaid || 0) > 0 || (rec.payments?.length || 0) > 0
  if (touchedByMoney && !INCLUDE_PAID) skippedPaid.push({ rec, have, want })
  else toFix.push({ rec, have, want })
}

console.log(
  `${APPLY ? 'APPLY' : 'DRY RUN'} — ${cells.length} fee cells scanned` +
  `${INCLUDE_PAID ? '  [--include-paid: PAID cells will be rewritten too — dev/test data only]' : ''}\n`,
)

console.log(`Mismatched and safe to realign: ${toFix.length}`)
for (const { rec, have, want } of toFix.slice(0, 40)) {
  console.log(
    `  ${labelOf.get(String(rec.studentId))}  ${rec.year}-${String(rec.month).padStart(2, '0')}  ` +
    `amount=${rec.amount}  ${have} -> ${want}`,
  )
}
if (toFix.length > 40) console.log(`  … and ${toFix.length - 40} more`)

if (skippedPaid.length) {
  console.log(`\nMismatched but PAID — left alone, review by hand: ${skippedPaid.length}`)
  for (const { rec, have, want } of skippedPaid.slice(0, 40)) {
    console.log(
      `  ${labelOf.get(String(rec.studentId))}  ${rec.year}-${String(rec.month).padStart(2, '0')}  ` +
      `paid=${rec.amountPaid} ${have}  (student bills in ${want})`,
    )
  }
  if (skippedPaid.length > 40) console.log(`  … and ${skippedPaid.length - 40} more`)
}

if (orphans.length) {
  console.log(`\nCells whose student no longer exists: ${orphans.length} (left alone)`)
}

if (!APPLY) {
  console.log('\nNothing written. Re-run with --apply to commit the realignment.')
} else if (toFix.length) {
  const ops = toFix.map(({ rec, want }) => ({
    updateOne: { filter: { _id: rec._id }, update: { $set: { currency: want } } },
  }))
  const res = await StudentFeeRecord.bulkWrite(ops)
  console.log(`\nUpdated ${res.modifiedCount} of ${toFix.length} cells.`)
} else {
  console.log('\nNothing to do — every cell already matches its student.')
}

await mongoose.disconnect()

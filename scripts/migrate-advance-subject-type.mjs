// Add-only migration: stamp `subjectType: 'tutor'` onto advances created before
// staff advances existed. Every legacy advance has a tutorId, so the backfill is
// unambiguous. Only documents MISSING subjectType are touched — nothing is
// overwritten, and re-running is a no-op. Idempotent.
//
//   node scripts/migrate-advance-subject-type.mjs           # dry run (default)
//   node scripts/migrate-advance-subject-type.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Advance from '../models/Advance.js'

const APPLY = process.argv.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

const total = await Advance.countDocuments()
const missing = await Advance.countDocuments({ subjectType: { $exists: false } })
const alreadyTagged = await Advance.countDocuments({ subjectType: { $exists: true } })

console.log(`${total} advance(s) total — ${alreadyTagged} already tagged, ${missing} missing subjectType`)

// Safety check: a legacy row without a tutorId would become an orphan (neither a
// tutor nor a staff subject), so surface it instead of guessing.
const orphans = await Advance.find({ subjectType: { $exists: false }, tutorId: null })
  .select('_id totalAmount status').lean()
if (orphans.length) {
  console.log(`\nWARNING: ${orphans.length} untagged advance(s) have no tutorId and will be SKIPPED:`)
  orphans.forEach(o => console.log(`  ${o._id} — ${o.status} ${o.totalAmount}`))
}

const target = await Advance.countDocuments({ subjectType: { $exists: false }, tutorId: { $ne: null } })
console.log(`\n${APPLY ? 'Tagging' : 'Would tag'} ${target} advance(s) as subjectType='tutor'.`)

if (APPLY && target > 0) {
  const res = await Advance.updateMany(
    { subjectType: { $exists: false }, tutorId: { $ne: null } },
    { $set: { subjectType: 'tutor' } },
  )
  console.log(`Applied — ${res.modifiedCount} document(s) updated.`)
} else if (!APPLY && target > 0) {
  console.log('Re-run with --apply to write these changes.')
}

await mongoose.disconnect()

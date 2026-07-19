// Migration: give lesson-logging roles the narrow `tutor.pick` permission so they
// can select a tutor in the lesson pickers (e.g. Submit Permanent Lesson) WITHOUT
// the broad `tutor.read` that also exposes the Tutors directory tab + counts.
//
// - The `tutor` role: ADD `tutor.pick`, REMOVE `tutor.read` (tutors should not see
//   the Tutors directory tab or counts — but must still pick a tutor when logging).
// - Any other role holding `lesson.log` but lacking both `tutor.read` and
//   `tutor.pick`: ADD `tutor.pick` so its lesson logging keeps working.
//
// Idempotent. Dry-run by default; pass --apply to write.
//
//   node scripts/migrate-tutor-pick-perm.mjs           # dry run (no writes)
//   node scripts/migrate-tutor-pick-perm.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const APPLY = process.argv.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

const roles = await Role.find().select('key name permissions').lean()
let changed = 0

for (const role of roles) {
  const perms = role.permissions || []
  const has = (p) => perms.includes(p)
  const adds = []
  const removes = []

  if (role.key === 'tutor') {
    if (!has('tutor.pick')) adds.push('tutor.pick')
    if (has('tutor.read')) removes.push('tutor.read')
  } else if (has('lesson.log') && !has('tutor.read') && !has('tutor.pick')) {
    adds.push('tutor.pick')
  }

  if (adds.length === 0 && removes.length === 0) {
    console.log(`SKIP    ${role.key} — already correct`)
    continue
  }
  console.log(`${APPLY ? 'UPDATE' : 'WOULD'}  ${role.key} — ${adds.length ? `add [${adds.join(', ')}]` : ''}${adds.length && removes.length ? ', ' : ''}${removes.length ? `remove [${removes.join(', ')}]` : ''}`)
  changed++
  if (APPLY) {
    if (adds.length) await Role.updateOne({ _id: role._id }, { $addToSet: { permissions: { $each: adds } } })
    if (removes.length) await Role.updateOne({ _id: role._id }, { $pull: { permissions: { $in: removes } } })
  }
}

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')

await mongoose.disconnect()

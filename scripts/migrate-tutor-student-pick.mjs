// Migration: give lesson-logging roles the narrow `student.pick` permission (so
// they can select a student in the lesson/assessment pickers) WITHOUT the broad
// `student.read` that also exposes the student directory + org-wide counts.
//
// - The `tutor` role: ADD `student.pick`, REMOVE `student.read` (tutors should not
//   see the students directory or counts — but must still log lessons).
// - Any other role holding `lesson.log` but lacking both `student.read` and
//   `student.pick`: ADD `student.pick` so its lesson logging keeps working.
//
// Idempotent. Dry-run by default; pass --apply to write.
//
//   node scripts/migrate-tutor-student-pick.mjs           # dry run (no writes)
//   node scripts/migrate-tutor-student-pick.mjs --apply   # write changes
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
    if (!has('student.pick')) adds.push('student.pick')
    if (has('student.read')) removes.push('student.read')
  } else if (has('lesson.log') && !has('student.read') && !has('student.pick')) {
    adds.push('student.pick')
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

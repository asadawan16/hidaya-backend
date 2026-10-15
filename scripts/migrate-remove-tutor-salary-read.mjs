// Migration: take `salary.read` off the `tutor` role. Production had it ticked
// (so tutors could see their own pay), which let every tutor read every tutor's
// and staff member's salary through /portal/finance/salary. Tutors now see their
// own pay on /portal/my-salary, which needs no permission. Touches ONLY that one
// permission on that one role ($pull). The controller also self-scopes tutor
// accounts, so re-ticking it later no longer leaks — this just tidies the role.
// Idempotent. Dry-run by default; pass --apply to write.
//
//   node scripts/migrate-remove-tutor-salary-read.mjs           # dry run (no writes)
//   node scripts/migrate-remove-tutor-salary-read.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const PERM = 'salary.read'
const TARGET_ROLE = 'tutor'
const APPLY = process.argv.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

const role = await Role.findOne({ key: TARGET_ROLE }).select('key permissions')
let changed = 0
if (!role) {
  console.log(`KEEP    no "${TARGET_ROLE}" role found — nothing to do`)
} else if (!(role.permissions || []).includes(PERM)) {
  console.log(`SKIP    ${role.key} — does not have ${PERM}`)
} else {
  console.log(`${APPLY ? 'UPDATE' : 'WOULD'}  ${role.key} — removing [${PERM}] (has ${role.permissions.length} perms)`)
  changed++
  if (APPLY) await Role.updateOne({ _id: role._id }, { $pull: { permissions: PERM } })
}

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')
await mongoose.disconnect()

// Add-only migration: grant `notice.read` to the `student` role so students can
// see notices addressed to them in the portal. Uses $addToSet so NO existing
// permission or role customization is overwritten or removed. Idempotent.
//
//   node scripts/migrate-student-notices-perm.mjs           # dry run (default)
//   node scripts/migrate-student-notices-perm.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const NEW_PERM = 'notice.read'
const TARGET_ROLE = 'student'
const APPLY = process.argv.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

const role = await Role.findOne({ key: TARGET_ROLE }).select('key name permissions')
let changed = 0

if (!role) {
  console.log(`KEEP    no "${TARGET_ROLE}" role found — nothing to do`)
} else if ((role.permissions || []).includes(NEW_PERM)) {
  console.log(`SKIP    ${role.key} — already has ${NEW_PERM}`)
} else {
  console.log(`${APPLY ? 'UPDATE' : 'WOULD'}  ${role.key} — adding [${NEW_PERM}] (has ${role.permissions.length} perms)`)
  changed++
  if (APPLY) {
    await Role.updateOne({ _id: role._id }, { $addToSet: { permissions: NEW_PERM } })
  }
}

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')

await mongoose.disconnect()

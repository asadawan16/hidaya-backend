// Add-only migration: grant the new complaint.update / complaint.delete
// permissions to roles that already MANAGE complaints (i.e. hold notice.manage,
// which gates complaint resolve). Uses $addToSet so NO existing permission or
// role customization is overwritten or removed. Idempotent.
//
//   node scripts/migrate-add-complaint-perms.mjs           # dry run (default)
//   node scripts/migrate-add-complaint-perms.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const NEW_PERMS = ['complaint.update', 'complaint.delete']
const GATE = 'notice.manage' // roles that can manage/resolve complaints
const APPLY = process.argv.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

const roles = await Role.find().select('key name permissions').lean()
let changed = 0

for (const role of roles) {
  const perms = role.permissions || []
  const manages = perms.includes(GATE)
  const missing = NEW_PERMS.filter(p => !perms.includes(p))

  if (!manages) {
    // Not a complaint-managing role — leave completely untouched.
    if (missing.length < NEW_PERMS.length) {
      console.log(`KEEP    ${role.key} — already has some new perms but no ${GATE}; not modifying`)
    }
    continue
  }
  if (missing.length === 0) {
    console.log(`SKIP    ${role.key} — already has ${NEW_PERMS.join(', ')}`)
    continue
  }

  console.log(`${APPLY ? 'UPDATE' : 'WOULD'}  ${role.key} — adding [${missing.join(', ')}] (has ${perms.length} perms)`)
  changed++

  if (APPLY) {
    await Role.updateOne(
      { _id: role._id },
      { $addToSet: { permissions: { $each: NEW_PERMS } } },
    )
  }
}

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')

await mongoose.disconnect()

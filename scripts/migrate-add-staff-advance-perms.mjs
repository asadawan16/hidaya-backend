// Add-only migration: staff advances now exist, so management/support roles that
// are themselves on payroll can hold + request their own advance. Grants
// `advance.read` / `advance.request` to the non-tutor, non-student staff roles.
//
// Uses $addToSet so NO existing permission or role customization is overwritten
// or removed. Roles outside the target list are left completely untouched.
// Idempotent.
//
//   node scripts/migrate-add-staff-advance-perms.mjs           # dry run (default)
//   node scripts/migrate-add-staff-advance-perms.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

// Payroll-subject staff roles. super_admin/admin already hold every permission;
// tutor already had both; student is not on payroll.
const TARGET_ROLES = ['principal', 'coordinator', 'qci', 'qcm']
const NEW_PERMS = ['advance.read', 'advance.request']
const APPLY = process.argv.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

const roles = await Role.find().select('key name permissions').lean()
let changed = 0

for (const role of roles) {
  if (!TARGET_ROLES.includes(role.key)) continue

  const perms = role.permissions || []
  const missing = NEW_PERMS.filter(p => !perms.includes(p))

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

const untouched = roles.filter(r => !TARGET_ROLES.includes(r.key)).map(r => r.key)
if (untouched.length) console.log(`\nUntouched roles: ${untouched.join(', ')}`)

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')

await mongoose.disconnect()

// Add-only migration: grant the new staff.read + staff.manage permissions ONLY to
// roles that already hold salary.manage (the actual payroll managers). We deliberately
// do NOT couple to salary.read — some roles (e.g. tutor) hold salary.read just to view
// their own pay, and must NOT gain access to the org-wide staff directory.
// Grant staff.read to any additional view-only role manually via the Roles page.
// Uses $addToSet so NO existing permission or role customization is overwritten
// or removed — upsert only. Idempotent.
//
//   node scripts/migrate-add-staff-perms.mjs           # dry run (default)
//   node scripts/migrate-add-staff-perms.mjs --apply   # write changes
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
  // Only payroll managers (salary.manage) get staff HR access.
  if (!perms.includes('salary.manage')) continue // leave every other role untouched

  const want = ['staff.read', 'staff.manage']
  const missing = want.filter(p => !perms.includes(p))
  if (missing.length === 0) {
    console.log(`SKIP    ${role.key} — already has [${want.join(', ')}]`)
    continue
  }

  console.log(`${APPLY ? 'UPDATE' : 'WOULD'}  ${role.key} — adding [${missing.join(', ')}] (has ${perms.length} perms)`)
  changed++

  if (APPLY) {
    await Role.updateOne(
      { _id: role._id },
      { $addToSet: { permissions: { $each: missing } } },
    )
  }
}

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')

await mongoose.disconnect()

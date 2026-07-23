// Add-only migration: grant schedule.session_status to the roles that oversee the
// teaching schedule (super_admin, admin, qci) so they can edit a session's
// status/attendance to any enum value (late, missed, on-time…) beyond the
// super-admin reset-to-scheduled action. Uses $addToSet so NO existing permission
// or customization is removed. Idempotent — safe to run repeatedly.
//
//   node scripts/migrate-add-session-status-perm.mjs           # dry run (default)
//   node scripts/migrate-add-session-status-perm.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const NEW_PERMS = ['schedule.session_status']
const TARGET_KEYS = ['super_admin', 'admin', 'qci']
const APPLY = process.argv.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

let changed = 0
for (const key of TARGET_KEYS) {
  const role = await Role.findOne({ key }).select('key permissions').lean()
  if (!role) { console.log(`SKIP    ${key} — role not found`); continue }
  const missing = NEW_PERMS.filter(p => !(role.permissions || []).includes(p))
  if (missing.length === 0) { console.log(`SKIP    ${key} — already has ${NEW_PERMS.join(', ')}`); continue }

  console.log(`${APPLY ? 'UPDATE' : 'WOULD'}  ${key} — adding [${missing.join(', ')}]`)
  changed++
  if (APPLY) {
    await Role.updateOne({ _id: role._id }, { $addToSet: { permissions: { $each: NEW_PERMS } } })
  }
}

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')

await mongoose.disconnect()

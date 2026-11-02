// Add-only migration: grant the English Coach permissions (coach.practice,
// coach.review, coach.manage) to the built-in roles that hold them by default
// in config/permissions.js:
//   super_admin, admin            practice + review + manage
//   principal, qci, qcm           practice + review
//   coordinator, tutor            practice
// Custom roles and the student role are left alone (grant from the Roles page).
// Uses $addToSet, so no existing permission or customisation is removed.
// Idempotent. Dry run by default; pass --apply to write.
//
//   node scripts/migrate-add-coach-perms.mjs           # dry run (no writes)
//   node scripts/migrate-add-coach-perms.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from '../config/permissions.js'

const COACH = PERMISSIONS.coach
const APPLY = process.argv.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

const roles = await Role.find({ key: { $in: Object.keys(DEFAULT_ROLE_PERMISSIONS) } }).select('key permissions').lean()
let changed = 0

for (const role of roles) {
  const wanted = (DEFAULT_ROLE_PERMISSIONS[role.key] || []).filter(p => COACH.includes(p))
  const missing = wanted.filter(p => !(role.permissions || []).includes(p))
  if (!wanted.length) { console.log(`KEEP    ${role.key} — no English Coach permissions by default`); continue }
  if (!missing.length) { console.log(`SKIP    ${role.key} — already has ${wanted.join(', ')}`); continue }
  console.log(`${APPLY ? 'UPDATE' : 'WOULD'}  ${role.key} — adding [${missing.join(', ')}]`)
  changed++
  if (APPLY) await Role.updateOne({ _id: role._id }, { $addToSet: { permissions: { $each: missing } } })
}

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')

await mongoose.disconnect()

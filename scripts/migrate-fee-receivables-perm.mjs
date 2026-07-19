// Migration: grant the new `fee.receivables` permission (Receivables tab + summary
// KPIs on the Fee Management page) to the `super_admin` role only. All other roles
// — including `admin` — are intentionally left without it (super-admin by default;
// grant to others via the Roles UI). Uses $addToSet so nothing else is touched.
// Idempotent. Dry-run by default; pass --apply to write.
//
//   node scripts/migrate-fee-receivables-perm.mjs           # dry run (no writes)
//   node scripts/migrate-fee-receivables-perm.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const NEW_PERM = 'fee.receivables'
const TARGET_ROLE = 'super_admin'
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
  if (APPLY) await Role.updateOne({ _id: role._id }, { $addToSet: { permissions: NEW_PERM } })
}

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')

await mongoose.disconnect()

// Migration: grant the new `fee.tracker` permission (the Fee Tracker page,
// /portal/fee-tracker) to the `super_admin` role only. Every other role —
// including `admin` — is left without it, like fee.receivables; grant it to
// others from the Roles page. Uses $addToSet so nothing else is touched.
// Idempotent. Dry-run by default; pass --apply to write.
//
//   node scripts/migrate-add-fee-tracker-perm.mjs           # dry run (no writes)
//   node scripts/migrate-add-fee-tracker-perm.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const NEW_PERM = 'fee.tracker'
const TARGET_ROLE = 'super_admin'
const APPLY = process.argv.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected to ${process.env.MONGODB_URI.split('@')[1]?.split('/')[0] || 'MongoDB'} (db "${mongoose.connection.name}"). Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

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

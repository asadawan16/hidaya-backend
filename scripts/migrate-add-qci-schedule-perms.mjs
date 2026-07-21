// Add-only migration: grant schedule.read + schedule.manage to the QCI role so it
// can see + manage the session board (QCI oversees the teaching schedule). Uses
// $addToSet so no existing permission or customization is removed. Idempotent.
//
//   node scripts/migrate-add-qci-schedule-perms.mjs           # dry run (default)
//   node scripts/migrate-add-qci-schedule-perms.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const NEW_PERMS = ['schedule.read', 'schedule.manage']
const TARGET_KEYS = ['qci']
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

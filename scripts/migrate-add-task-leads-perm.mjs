// Migration: grant the 2026-11-11 permission task.leads ("link tasks to
// leads") to the existing admin role. Other roles can be given it on the
// Roles page. super_admin gains it on its own at server start (index.js
// sync). Uses $addToSet, so nothing else is touched. Idempotent. Dry-run by
// default.
//
//   node scripts/migrate-add-task-leads-perm.mjs           # dry run (no writes)
//   node scripts/migrate-add-task-leads-perm.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const GRANTS = {
  admin: ['task.leads'],
}
const APPLY = process.argv.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected to db "${mongoose.connection.name}" on ${mongoose.connection.host}. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

let changed = 0
for (const [key, perms] of Object.entries(GRANTS)) {
  const role = await Role.findOne({ key }).select('key permissions')
  if (!role) { console.log(`KEEP    no "${key}" role`); continue }
  const missing = perms.filter(p => !(role.permissions || []).includes(p))
  if (!missing.length) { console.log(`SKIP    ${key} — already has ${perms.join(', ')}`); continue }
  console.log(`${APPLY ? 'UPDATE' : 'WOULD'}  ${key} — adding [${missing.join(', ')}]`)
  changed++
  if (APPLY) await Role.updateOne({ _id: role._id }, { $addToSet: { permissions: { $each: missing } } })
}

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')
await mongoose.disconnect()

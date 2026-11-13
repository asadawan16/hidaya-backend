// Migration: grant the Tasks permissions to existing roles.
//   task.manage (see + manage every task) + task.leads → admin
//   task.create (create and assign tasks)               → admin, principal, coordinator, qci
// (task.read is retired — see migrate-retire-task-read.mjs)
// super_admin gains them on its own at server start (index.js sync). Uses
// $addToSet, so nothing else is touched. Idempotent. Dry-run by default.
// Everyone can already work their own tasks without any of these.
//
//   node scripts/migrate-add-task-perms.mjs           # dry run (no writes)
//   node scripts/migrate-add-task-perms.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const GRANTS = {
  admin: ['task.create', 'task.manage', 'task.leads'],
  principal: ['task.create'],
  coordinator: ['task.create'],
  qci: ['task.create'],
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

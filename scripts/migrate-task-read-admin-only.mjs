// Migration (client request, 13 Nov 2026: "everyone sees every task, even
// ones not assigned to them"): take task.read — "see every task" — off the
// principal, coordinator and qci roles. They keep task.manage, so they still
// assign and edit tasks, and see the ones they created, are on or watch.
// admin and super_admin keep task.read. Only that one permission is pulled;
// nothing else on any role is touched. Idempotent. Dry-run by default.
// To give it back to someone, tick "task.read" on the Roles page.
//
//   node scripts/migrate-task-read-admin-only.mjs           # dry run (no writes)
//   node scripts/migrate-task-read-admin-only.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const ROLES = ['principal', 'coordinator', 'qci']
const APPLY = process.argv.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected to db "${mongoose.connection.name}" on ${mongoose.connection.host}. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

let changed = 0
for (const key of ROLES) {
  const role = await Role.findOne({ key }).select('key permissions')
  if (!role) { console.log(`KEEP    no "${key}" role`); continue }
  if (!(role.permissions || []).includes('task.read')) { console.log(`SKIP    ${key} — has no task.read`); continue }
  console.log(`${APPLY ? 'UPDATE' : 'WOULD'}  ${key} — removing task.read`)
  changed++
  if (APPLY) await Role.updateOne({ _id: role._id }, { $pull: { permissions: 'task.read' } })
}
const others = await Role.find({ key: { $nin: [...ROLES, 'admin', 'super_admin'] }, permissions: 'task.read' }).select('key').lean()
if (others.length) console.log(`\nNOTE    also holding task.read (left alone): ${others.map(r => r.key).join(', ')}`)

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')
await mongoose.disconnect()

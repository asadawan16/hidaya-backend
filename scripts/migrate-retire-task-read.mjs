// Migration (13 Nov 2026): retire `task.read` and bring in `task.create`.
//
// task.read meant "see EVERY task", but on the Roles page it read like "can use
// tasks" and ended up on tutor and student roles — so tutors saw every task,
// even unassigned ones. Now:
//   - nobody needs a permission to see and work their own tasks
//   - task.create  creates tasks and assigns them (the creator edits them)
//   - task.manage  sees and manages every task
//
// For every role this script:
//   - removes task.read (the code no longer reads it; Role saves drop it too)
//   - adds task.create where the role could already create or was clearly
//     meant to use the board (it held task.read or task.manage) — EXCEPT
//     tutor, student and meta_reviewer: tutors and students only work the
//     tasks they are given. Tick "task.create" on the Roles page to change that.
// task.manage is never added or removed. Idempotent. Dry-run by default.
//
//   node scripts/migrate-retire-task-read.mjs                 # dry run (no writes)
//   node scripts/migrate-retire-task-read.mjs --apply         # write changes
//   node scripts/migrate-retire-task-read.mjs --no-create     # only remove task.read
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const APPLY = process.argv.includes('--apply')
const GRANT_CREATE = !process.argv.includes('--no-create')
const NEVER_CREATE = ['tutor', 'student', 'meta_reviewer']

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected to db "${mongoose.connection.name}" on ${mongoose.connection.host}. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

let changed = 0
for (const role of await Role.find({}).select('key name permissions').lean()) {
  const perms = role.permissions || []
  const hadRead = perms.includes('task.read')
  const giveCreate = GRANT_CREATE && !NEVER_CREATE.includes(role.key) && !perms.includes('task.create')
    && (hadRead || perms.includes('task.manage'))
  if (!hadRead && !giveCreate) continue
  const steps = [hadRead && 'remove task.read', giveCreate && 'add task.create'].filter(Boolean).join(', ')
  const left = ['task.create', 'task.manage', 'task.leads'].filter(p => perms.includes(p) || (p === 'task.create' && giveCreate))
  console.log(`${APPLY ? 'UPDATE' : 'WOULD '}  ${role.key.padEnd(18)} ${steps.padEnd(36)} → tasks: ${left.join(', ') || 'own tasks only'}`)
  changed++
  if (APPLY) {
    if (hadRead) await Role.updateOne({ _id: role._id }, { $pull: { permissions: 'task.read' } })
    if (giveCreate) await Role.updateOne({ _id: role._id }, { $addToSet: { permissions: 'task.create' } })
  }
}

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')
await mongoose.disconnect()

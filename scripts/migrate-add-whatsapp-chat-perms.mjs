// Add-only migration for WhatsApp Chats (/portal/whatsapp-chats):
//   whatsapp.chat   → super_admin, admin, principal, coordinator, qci, qcm
//   whatsapp.inbox  → super_admin, admin   (numbers, fee messages, media, templates)
// Matched on the role KEY, so custom roles are left alone — grant those from
// the Roles page. $addToSet only: nothing existing is removed or reset. Idempotent.
//
//   node scripts/migrate-add-whatsapp-chat-perms.mjs           # dry run (default)
//   node scripts/migrate-add-whatsapp-chat-perms.mjs --apply   # write changes
import 'dotenv/config'
import mongoose from 'mongoose'
import Role from '../models/Role.js'

const GRANTS = {
  super_admin: ['whatsapp.chat', 'whatsapp.inbox'],
  admin: ['whatsapp.chat', 'whatsapp.inbox'],
  principal: ['whatsapp.chat'],
  coordinator: ['whatsapp.chat'],
  qci: ['whatsapp.chat'],
  qcm: ['whatsapp.chat'],
}
const APPLY = process.argv.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

const roles = await Role.find({ key: { $in: Object.keys(GRANTS) } }).select('key permissions').lean()
let changed = 0
for (const role of roles) {
  const missing = GRANTS[role.key].filter(p => !(role.permissions || []).includes(p))
  if (!missing.length) {
    console.log(`SKIP    ${role.key} — already has ${GRANTS[role.key].join(', ')}`)
    continue
  }
  console.log(`${APPLY ? 'UPDATE' : 'WOULD'}  ${role.key} — adding [${missing.join(', ')}]`)
  changed++
  if (APPLY) await Role.updateOne({ _id: role._id }, { $addToSet: { permissions: { $each: missing } } })
}
for (const key of Object.keys(GRANTS)) {
  if (!roles.some(r => r.key === key)) console.log(`MISSING ${key} — no such role in this database`)
}

console.log(`\n${APPLY ? 'Applied to' : 'Would change'} ${changed} role(s).`)
if (!APPLY && changed > 0) console.log('Re-run with --apply to write these changes.')
console.log('Signed-in users pick the new permission up on their next page load.')
await mongoose.disconnect()

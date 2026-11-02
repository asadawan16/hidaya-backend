// Add-only migration: offer the 3-minute English Coach call on an existing
// settings document (new installs get 3 / 5 / 10 by default). Nothing else in
// the settings is touched, and an admin who removes 3 later keeps it removed
// unless this is run again. Idempotent. Dry run by default; --apply to write.
//
//   node scripts/migrate-coach-add-3min.mjs           # dry run (no writes)
//   node scripts/migrate-coach-add-3min.mjs --apply   # write the change
import 'dotenv/config'
import mongoose from 'mongoose'
import CoachSettings from '../models/CoachSettings.js'

const APPLY = process.argv.includes('--apply')
await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

const s = await CoachSettings.findOne({ key: 'default' }).lean()
if (!s) {
  console.log('KEEP    no settings saved yet — the default (3, 5, 10 min) applies')
} else if ((s.durations || []).includes(3)) {
  console.log(`SKIP    already offers 3 min (${s.durations.join(', ')})`)
} else {
  const next = [...new Set([3, ...(s.durations || [])])].sort((a, b) => a - b)
  console.log(`${APPLY ? 'UPDATE' : 'WOULD '}  call lengths ${s.durations.join(', ')} → ${next.join(', ')} min`)
  if (APPLY) await CoachSettings.updateOne({ _id: s._id }, { $set: { durations: next } })
}
await mongoose.disconnect()

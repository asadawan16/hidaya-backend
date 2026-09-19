// Re-address existing per-student class pages on the student's ROLL NUMBER, so
// every live page is /my-class/hid518 rather than /my-class/Q-qxsZ8g9tXd.
//
// New links have been minted this way since the change; this is the backlog.
// It is a URL change: a link already sitting in a parent's WhatsApp stops
// working the moment this runs, so re-send the ones you have shared. Run it in
// one pass rather than letting the two formats coexist — half a roll-numbered
// set is worse than none.
//
// Idempotent, and it never takes a token away from another link: a student with
// no roll number, or whose slug is already spoken for, keeps the random token
// they have.
//
//   node scripts/migrate-student-link-roll-tokens.mjs           # dry run (default)
//   node scripts/migrate-student-link-roll-tokens.mjs --apply   # write changes
//
// The links that need this live in the PRODUCTION database, which is not the
// one .env points at — so `--uri` overrides it for this run rather than asking
// anyone to edit .env and remember to put it back:
//
//   node scripts/migrate-student-link-roll-tokens.mjs --uri="mongodb+srv://…"
import 'dotenv/config'
import mongoose from 'mongoose'
import StudentClassLink, { tokenFromRollNo } from '../models/StudentClassLink.js'
import Student from '../models/Student.js'

const APPLY = process.argv.includes('--apply')
const uriArg = process.argv.find(a => a.startsWith('--uri='))
const URI = uriArg ? uriArg.slice('--uri='.length) : process.env.MONGODB_URI

if (!URI) {
  console.error('No database. Set MONGODB_URI in .env or pass --uri="mongodb+srv://…".')
  process.exit(1)
}

await mongoose.connect(URI)
console.log(`Connected to "${mongoose.connection.name}". Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

const links = await StudentClassLink.find().select('token student studentName rollNo').lean()

// The link carries a roll-number snapshot taken at publish time; fall back to
// the student record for links minted before that field was filled in.
const students = await Student
  .find({ _id: { $in: links.map(l => l.student) } })
  .select('rollNo')
  .lean()
const rollById = new Map(students.map(s => [String(s._id), s.rollNo || '']))

// Every token currently in use, lowercased → the link that owns it. A slug is
// only free if nothing else answers to it.
const owners = new Map(links.map(l => [String(l.token).toLowerCase(), String(l._id)]))

let changed = 0
let skipped = 0

for (const link of links) {
  const roll = link.rollNo || rollById.get(String(link.student)) || ''
  const slug = tokenFromRollNo(roll)
  const current = String(link.token)

  if (!slug) {
    console.log(`SKIP    ${link.studentName} — no roll number, keeping ${current}`)
    skipped++
    continue
  }
  if (current.toLowerCase() === slug) continue // already addressed by roll number

  const owner = owners.get(slug)
  if (owner && owner !== String(link._id)) {
    console.log(`SKIP    ${link.studentName} — "${slug}" already belongs to another link, keeping ${current}`)
    skipped++
    continue
  }

  console.log(`${APPLY ? 'UPDATE' : 'WOULD'}  ${link.studentName}: /my-class/${current} → /my-class/${slug}`)
  changed++

  if (APPLY) {
    await StudentClassLink.updateOne({ _id: link._id }, { $set: { token: slug, rollNo: roll } })
    owners.delete(current.toLowerCase())
    owners.set(slug, String(link._id))
  }
}

console.log(
  `\n${links.length} link(s) · ${changed} ${APPLY ? 'updated' : 'would change'} · ${skipped} left on a random token`,
)
if (!APPLY && changed) console.log('Re-run with --apply to write.')

await mongoose.disconnect()

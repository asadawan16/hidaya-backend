// Import the "Tutor Change Entries" sheet → TutorChangeRequest records (history).
//   • Each row records a student's tutor change: Current Tutor → New Teacher,
//     effective on the "New Tutor Change Date". Students are matched by the
//     "Student Reg #" column → Student.rollNo.
//   • Tutors in the sheet are bare numbers (2–20). These map 1:1 to existing
//     TutorProfiles by tutorId = "T" + zero-padded number (4 → T04, 10 → T10).
//     Any number with no TutorProfile (e.g. T04) is created as an INACTIVE
//     placeholder tutor + suspended login account, so the reference resolves.
//   • The sheet has no track; imported changes default to DEFAULT_TRACK. Records
//     are stored as status 'approved' (they are historical, completed changes)
//     with reviewedAt = change date. The original tokens + dates are preserved
//     in `reason` for traceability.
//
// Non-destructive + re-runnable: imported records carry a fixed marker in
// `reviewNotes` (IMPORT_TAG). The script deletes ONLY its own previously-imported
// records before re-inserting — any manually-created / seeded tutor-change
// requests (which have no marker) are left untouched.
//
// Run from hidayah-backend:  node scripts/import-tutor-changes.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import path from 'path'
import xlsx from 'xlsx'
import { loadAllModels, parseDate } from './students-lib.mjs'
import { tokenToTutorId, makeTutorResolver } from './tutor-lib.mjs'

const BE = process.cwd()
const XLSX_PATH = process.env.STUDENTS_XLSX || path.resolve(BE, '..', 'Students Data.xlsx')
const SHEET = 'Tutor Change Entries'
const IMPORT_TAG = 'Imported from Tutor Change Entries'
const DEFAULT_TRACK = 'nazra' // sheet carries no track; matches existing seed default

// 0-based column indexes.
const C = { ts: 0, email: 1, reg: 2, name: 3, lastChange: 4, fromTutor: 5, changeDate: 6, toTutor: 7 }

// Parse the sheet's "Timestamp" column (date + time), e.g. "1/19/2024 2:39:39".
function parseTimestamp(v) {
  if (v == null || v === '') return null
  const d = new Date(String(v).trim())
  return isNaN(d.getTime()) ? null : d
}

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Reading ${XLSX_PATH}`)
await loadAllModels(BE)
const Student = mongoose.model('Student')
const TutorChangeRequest = mongoose.model('TutorChangeRequest')

// ── Map sheet tutor tokens → TutorProfile _id, creating inactive placeholders
//    for any that don't exist yet (e.g. T04). ──
const { resolve: resolveTutor, created: createdTutors } = await makeTutorResolver()

// ── Read sheet ──
const wb = xlsx.readFile(XLSX_PATH)
const ws = wb.Sheets[SHEET]
if (!ws) throw new Error(`Sheet "${SHEET}" not found. Sheets: ${wb.SheetNames.join(', ')}`)
const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })

// ── Student lookup by rollNo ──
const rollToId = new Map((await Student.find({}, 'rollNo').lean()).map(s => [String(s.rollNo).trim().toUpperCase(), s._id]))

// ── Clear only this import's previous records (non-destructive, re-runnable) ──
const cleared = await TutorChangeRequest.deleteMany({ reviewNotes: IMPORT_TAG })
console.log(`Cleared ${cleared.deletedCount} previously-imported tutor-change records.`)

// ── Build documents ──
const docs = []
let matched = 0, noToTutor = 0
const unmatched = new Map()
for (let r = 1; r < rows.length; r++) {
  const row = rows[r]
  const reg = String(row[C.reg] ?? '').trim().toUpperCase()
  if (!reg && !row.some(v => String(v).trim() !== '')) continue
  const studentId = rollToId.get(reg)
  if (!studentId) { if (reg) unmatched.set(reg, (unmatched.get(reg) || 0) + 1); continue }

  const toTutorId = await resolveTutor(row[C.toTutor])
  if (!toTutorId) { noToTutor++; continue } // toTutorId is required by the model
  const fromTutorId = await resolveTutor(row[C.fromTutor])

  const changeDate = parseDate(row[C.changeDate])
  // Sheet "Timestamp" (col 0) is when the change was logged, e.g. "1/19/2024 2:39:39".
  const loggedAt = parseTimestamp(row[C.ts]) || changeDate
  const reasonBits = [
    `Imported tutor change`,
    `${tokenToTutorId(row[C.fromTutor]) || '—'} → ${tokenToTutorId(row[C.toTutor])}`,
    changeDate ? `on ${String(row[C.changeDate]).trim()}` : null,
    row[C.lastChange] ? `(prev change: ${String(row[C.lastChange]).trim()})` : null,
  ].filter(Boolean)

  matched++
  docs.push({
    studentId,
    track: DEFAULT_TRACK,
    fromTutorId: fromTutorId || null,
    toTutorId,
    reason: reasonBits.join(' '),
    status: 'approved',
    requestedByRole: 'import',
    reviewedAt: changeDate || undefined,
    reviewNotes: IMPORT_TAG,
    // Preserve the real timeline: the list UI shows createdAt as the record's date.
    createdAt: loggedAt || undefined,
    updatedAt: loggedAt || undefined,
  })
}
console.log(`Rows matched to a student: ${matched}. Skipped (no valid new tutor): ${noToTutor}. Unmatched regs: ${unmatched.size}.`)

// ── Bulk insert (timestamps:false so our createdAt/updatedAt are kept as-is) ──
let inserted = 0
for (let i = 0; i < docs.length; i += 1000) {
  const batch = docs.slice(i, i + 1000)
  await TutorChangeRequest.insertMany(batch, { ordered: false, timestamps: false })
  inserted += batch.length
}

// ── Report ──
console.log('\n─────────── Tutor-change import summary ───────────')
console.log(`Tutor-change records inserted : ${inserted}`)
console.log(`Distinct students             : ${new Set(docs.map(d => String(d.studentId))).size}`)
console.log(`Inactive tutors created       : ${createdTutors.length ? createdTutors.join(', ') : 'none'}`)
if (unmatched.size) {
  const top = [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  console.log(`\nUnmatched regs (${unmatched.size}) — no Student with that rollNo, rows skipped:`)
  console.log('  ' + top.map(([k, v]) => `${k}(${v})`).join(', ') + (unmatched.size > 20 ? ' …' : ''))
}
console.log(`\nVerify → TutorChangeRequest total: ${await TutorChangeRequest.countDocuments()}, this import: ${await TutorChangeRequest.countDocuments({ reviewNotes: IMPORT_TAG })}, untouched others: ${await TutorChangeRequest.countDocuments({ reviewNotes: { $ne: IMPORT_TAG } })}`)

await mongoose.disconnect()
console.log('DONE')

// Import the "Students Daily Lesson Data" sheet → LessonEntry records.
//   • Each sheet row is one daily class log for a student on a given date.
//     Students are matched by the "Student Roll #" column → Student.rollNo.
//   • The sheet has NO per-lesson tutor column. The tutor is inferred from the
//     "Tutor Change Entries" sheet: each student's dated tutor-change timeline
//     tells us which tutor was active on the lesson's date. Lessons whose date
//     no timeline covers (or students with no change history) fall back to the
//     shared placeholder tutor (IMPORT-UNASSIGNED). LessonEntry.tutorId is
//     required.
//   • The lesson content (Qaida/Quran/Kalima/Dua/Namaz/Islamic Study/Hifz) is
//     flattened into a human-readable `customText` — the sheet mixes page/line/
//     para in one row, which does not map cleanly to a single curriculum item,
//     and customText renders as-is in the portal. No curriculum is created.
//   • kind = 'revision' when a row's only content is "revise", else 'daily'.
//
// Non-destructive + re-runnable: every imported entry carries a fixed marker in
// `notes` (IMPORT_TAG). The script deletes ONLY its own previously-imported
// entries before re-inserting, so any lessons created elsewhere are untouched.
//
// Run from hidayah-backend:  node scripts/import-daily-lessons.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import path from 'path'
import xlsx from 'xlsx'
import { loadAllModels, parseDate } from './students-lib.mjs'
import { makeTutorResolver } from './tutor-lib.mjs'

const BE = process.cwd()
const XLSX_PATH = process.env.STUDENTS_XLSX || path.resolve(BE, '..', 'Students Data.xlsx')
const SHEET = 'Students Daily Lesson Data'
const TUTOR_SHEET = 'Tutor Change Entries'
const IMPORT_TAG = 'Imported from Students Daily Lesson Data'

// 0-based column indexes in the sheet.
const C = {
  id: 0, date: 1, qaidaPage: 2, qaidaLine: 3, quranPara: 4, quranPage: 5, quranLine: 6,
  kalima: 7, dua: 8, namaz: 9, islamic: 10, hifz: 11, start: 12, end: 13, roll: 14,
}

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Reading ${XLSX_PATH}`)
await loadAllModels(BE)
const Student = mongoose.model('Student')
const TutorProfile = mongoose.model('TutorProfile')
const LessonEntry = mongoose.model('LessonEntry')
const User = mongoose.model('User')
const Role = mongoose.model('Role')

// ── Placeholder tutor (schema requires tutorId; sheet has no tutor) ──
async function ensurePlaceholderTutor() {
  const existing = await TutorProfile.findOne({ tutorId: 'IMPORT-UNASSIGNED' })
  if (existing) return existing
  const tutorRole = await Role.findOne({ key: 'tutor' })
  let user = await User.findOne({ email: 'import.unassigned@hidaya.online' })
  if (!user) {
    user = await User.create({
      email: 'import.unassigned@hidaya.online',
      password: 'Hidaya@123',
      displayName: 'Imported (Unassigned Tutor)',
      roles: tutorRole ? [tutorRole._id] : [],
      status: 'suspended',
    })
  }
  return TutorProfile.create({ tutorId: 'IMPORT-UNASSIGNED', userId: user._id, name: 'Imported (Unassigned Tutor)', status: 'inactive' })
}
const placeholderTutor = await ensurePlaceholderTutor()

// ── Read sheet ──
const wb = xlsx.readFile(XLSX_PATH)
const ws = wb.Sheets[SHEET]
if (!ws) throw new Error(`Sheet "${SHEET}" not found. Sheets: ${wb.SheetNames.join(', ')}`)
const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })

// ── Student lookup by rollNo ──
const rollToId = new Map((await Student.find({}, 'rollNo').lean()).map(s => [String(s.rollNo).trim().toUpperCase(), s._id]))

// ── Build each student's tutor timeline from the Tutor Change Entries sheet ──
// A timeline is a date-sorted list of { t, tutorId }: "from date t, tutor = X".
// We seed it with each change's (New Tutor Change Date → New Teacher) and each
// row's (Last Change Date → Current Tutor) so dates before the first change are
// also covered. When two points share a date, the change (New Teacher) wins.
const { resolve: resolveTutor, created: createdTutors } = await makeTutorResolver()
const TC = { ts: 0, reg: 2, lastChange: 4, fromTutor: 5, changeDate: 6, toTutor: 7 }
// The live sheet contains duplicate / contradictory change rows for some students
// (re-entered histories). Each point carries the row's form-submission time (`sub`);
// points are ordered by (date, sub, prio) so that on any given date the MOST RECENTLY
// SUBMITTED correction wins, and within one row a change (prio 1) beats the prior
// tutor (prio 0). prio-0 (Last Change Date → Current Tutor) points also extend
// coverage back before the first recorded change.
const timelines = new Map() // studentId string -> [{ t, tutorId }] sorted
{
  const tcRows = xlsx.utils.sheet_to_json(wb.Sheets[TUTOR_SHEET], { header: 1, defval: '', raw: false })
  const raw = new Map() // studentId -> [{ t, sub, prio, tutorId }]
  for (let r = 1; r < tcRows.length; r++) {
    const row = tcRows[r]
    const reg = String(row[TC.reg] ?? '').trim().toUpperCase()
    const sid = rollToId.get(reg)
    if (!sid) continue
    const key = String(sid)
    if (!raw.has(key)) raw.set(key, [])
    const list = raw.get(key)
    const subDt = new Date(String(row[TC.ts] ?? '').trim())
    const sub = isNaN(subDt.getTime()) ? 0 : subDt.getTime()
    const startD = parseDate(row[TC.lastChange]), fromT = await resolveTutor(row[TC.fromTutor])
    if (startD && fromT) list.push({ t: startD.getTime(), sub, prio: 0, tutorId: fromT })
    const changeD = parseDate(row[TC.changeDate]), toT = await resolveTutor(row[TC.toTutor])
    if (changeD && toT) list.push({ t: changeD.getTime(), sub, prio: 1, tutorId: toT })
  }
  for (const [key, list] of raw) {
    list.sort((a, b) => a.t - b.t || a.sub - b.sub || a.prio - b.prio)
    timelines.set(key, list.map(({ t, tutorId }) => ({ t, tutorId })))
  }
}
console.log(`Built tutor timelines for ${timelines.size} students. Placeholder tutors created: ${createdTutors.length ? createdTutors.join(', ') : 'none'}.`)

// Active tutor for a student on date D = the latest timeline point with t <= D.
function tutorForDate(studentKey, date) {
  const list = timelines.get(studentKey)
  if (!list || !list.length) return null
  const ms = date.getTime()
  let picked = null
  for (const p of list) { if (p.t <= ms) picked = p.tutorId; else break }
  return picked
}

// ── Clear only this import's previous entries (re-runnable, non-destructive) ──
const cleared = await LessonEntry.deleteMany({ notes: IMPORT_TAG })
console.log(`Cleared ${cleared.deletedCount} previously-imported daily lessons.`)

// ── Build customText from the content columns of a row ──
const REVISE = /revi[sc]e|rewaise/i
function buildLesson(row) {
  const g = (c) => String(row[c] ?? '').trim()
  const parts = []
  const qp = g(C.qaidaPage), ql = g(C.qaidaLine)
  if (qp || ql) parts.push(`Qaida: ${[qp && `Page ${qp}`, ql && `Line ${ql}`].filter(Boolean).join(', ')}`)
  const rp = g(C.quranPara), rpg = g(C.quranPage), rl = g(C.quranLine)
  if (rp || rpg || rl) parts.push(`Quran: ${[rp && `Para ${rp}`, rpg && `Page ${rpg}`, rl && `Line ${rl}`].filter(Boolean).join(', ')}`)
  const kal = g(C.kalima); if (kal) parts.push(/^\d+$/.test(kal) ? `Kalima ${kal}` : `Kalima: ${kal}`)
  const dua = g(C.dua); if (dua) parts.push(`Dua: ${dua}`)
  const nmz = g(C.namaz); if (nmz) parts.push(`Namaz: ${nmz}`)
  const isl = g(C.islamic); if (isl) parts.push(`Islamic Study: ${isl}`)
  const hfz = g(C.hifz); if (hfz) parts.push(`Hifz: ${hfz}`)

  const text = parts.join(' · ')
  // Revision if the only signal is "revise" and there are no page/para numbers.
  const hasNumbers = [qp, ql, rp, rpg, rl].some(Boolean)
  const kind = !hasNumbers && REVISE.test(text) ? 'revision' : 'daily'
  return { text, kind }
}

// ── Aggregate rows → documents ──
const docs = []
let matched = 0, badDate = 0, realTutor = 0, placeholderUsed = 0
const unmatched = new Map()   // roll -> count
for (let r = 1; r < rows.length; r++) {
  const row = rows[r]
  const roll = String(row[C.roll] ?? '').trim().toUpperCase()
  if (!roll && !row.some(v => String(v).trim() !== '')) continue // skip fully-blank row
  const studentId = rollToId.get(roll)
  if (!studentId) { if (roll) unmatched.set(roll, (unmatched.get(roll) || 0) + 1); continue }
  const date = parseDate(row[C.date])
  if (!date) { badDate++; continue }
  matched++

  // Infer the tutor active on this lesson's date from the change timeline.
  const inferred = tutorForDate(String(studentId), date)
  if (inferred) realTutor++; else placeholderUsed++

  const { text, kind } = buildLesson(row)
  docs.push({
    studentId,
    tutorId: inferred || placeholderTutor._id,
    date,
    classStart: String(row[C.start] ?? '').trim(),
    classEnd: String(row[C.end] ?? '').trim(),
    kind,
    items: [],
    customText: text,
    notes: IMPORT_TAG,
  })
}
console.log(`Rows matched to a student: ${matched}. Skipped bad-date rows: ${badDate}. Unmatched rolls: ${unmatched.size}.`)
console.log(`Tutor inferred from timeline: ${realTutor}. Fell back to placeholder: ${placeholderUsed}.`)

// ── Bulk insert ──
let inserted = 0
for (let i = 0; i < docs.length; i += 2000) {
  const batch = docs.slice(i, i + 2000)
  await LessonEntry.insertMany(batch, { ordered: false })
  inserted += batch.length
  if (inserted % 20000 === 0 || inserted === docs.length) console.log(`  inserted ${inserted}/${docs.length}…`)
}

// ── Report ──
console.log('\n─────────── Daily lesson import summary ───────────')
console.log(`Lesson entries inserted : ${inserted}`)
console.log(`Distinct students       : ${new Set(docs.map(d => String(d.studentId))).size}`)
console.log(`Tutor inferred / fallback : ${realTutor} / ${placeholderUsed}`)
console.log(`Placeholder tutor       : ${placeholderTutor.tutorId} (${placeholderTutor._id})`)
if (unmatched.size) {
  const top = [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  console.log(`\nUnmatched rolls (${unmatched.size}) — no Student with that rollNo, rows skipped:`)
  console.log('  ' + top.map(([k, v]) => `${k}(${v})`).join(', ') + (unmatched.size > 20 ? ' …' : ''))
}
console.log(`\nVerify → LessonEntry total: ${await LessonEntry.countDocuments()}, this import: ${await LessonEntry.countDocuments({ notes: IMPORT_TAG })}`)

await mongoose.disconnect()
console.log('DONE')

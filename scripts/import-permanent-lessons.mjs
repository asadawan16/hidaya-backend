// Import the "Students Permanent Data" sheet → PermanentLesson records.
//   • Each sheet row is a Google-Form snapshot; a student can have many rows.
//     We UNION a student's completed lessons across all their rows (earliest
//     dated cell wins) so the result is their full permanent-lesson history.
//   • Lesson columns are mapped to CurriculumItems — reusing the existing
//     curriculum where an equivalent exists, creating the rest (incl. the 30
//     Urdu duas). No model/schema changes.
//   • PermanentLesson.tutorId is required, so a single placeholder tutor is
//     used (the sheet's "Tutor #" is intentionally ignored for now).
//   • Quran-finish dates are folded into the student's notes.
//
// Re-runnable: clears existing PermanentLessons first; curriculum + placeholder
// tutor are get-or-created. A full `node scripts/reset-students.mjs` also
// removes every PermanentLesson (they carry a studentId ref).
//
// Run from hidayah-backend:  node scripts/import-permanent-lessons.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import path from 'path'
import xlsx from 'xlsx'
import { loadAllModels, parseDate } from './students-lib.mjs'

const BE = process.cwd()
const XLSX_PATH = process.env.STUDENTS_XLSX || path.resolve(BE, '..', 'Students Data.xlsx')
const SHEET = 'Students Permanent Data'

const COL = { timestamp: 0, email: 1, reg: 2, name: 3, tutor: 4, firstLesson: 5, lastLesson: 139, finishStart: 140, finishEnd: 144 }
const FINISH_LABELS = ['1st', '2nd', '3rd', '4th', '5th']

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Reading ${XLSX_PATH}`)
await loadAllModels(BE)
const Student = mongoose.model('Student')
const CurriculumItem = mongoose.model('CurriculumItem')
const PermanentLesson = mongoose.model('PermanentLesson')
const TutorProfile = mongoose.model('TutorProfile')
const User = mongoose.model('User')
const Role = mongoose.model('Role')

const wb = xlsx.readFile(XLSX_PATH)
const ws = wb.Sheets[SHEET]
if (!ws) throw new Error(`Sheet "${SHEET}" not found`)
const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })
const header = rows[2] // row 0-1 blank, row 2 = header

// ── Placeholder tutor (schema requires tutorId; sheet tutor is ignored) ──
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
      status: 'active',
    })
  }
  return TutorProfile.create({ tutorId: 'IMPORT-UNASSIGNED', userId: user._id, name: 'Imported (Unassigned Tutor)', status: 'inactive' })
}
const placeholderTutor = await ensurePlaceholderTutor()

// ── Resolve every lesson column → a CurriculumItem _id ──
const allItems = await CurriculumItem.find({}).lean()
const byLabel = new Map(allItems.map(i => [i.label.trim(), i]))
const quranByPara = new Map(allItems.filter(i => i.track === 'quran').map(i => [i.meta?.paraNumber, i]))
const kalimaByOrder = new Map(allItems.filter(i => i.track === 'kalima').map(i => [i.order, i]))

const createdItems = []
async function getOrCreate(track, type, label, order, meta = {}) {
  const found = byLabel.get(label.trim())
  if (found) return found._id
  const doc = await CurriculumItem.create({ track, type, label: label.trim(), order, meta, active: true })
  byLabel.set(label.trim(), doc)
  createdItems.push(label.trim())
  return doc._id
}

// Reuse an existing item, or create a sheet-faithful fallback if absent.
async function reuseOrCreate(label, fallback) {
  const found = byLabel.get(label.trim())
  if (found) return found._id
  return getOrCreate(fallback.track, fallback.type, label, fallback.order, fallback.meta || {})
}

const colItem = {} // col index → curriculumItem _id
for (let c = COL.firstLesson; c <= COL.lastLesson; c++) {
  const label = String(header[c] || '').trim()
  if (!label) continue

  if (c >= 5 && c <= 10) {                      // Kalima 1-6
    const n = c - 4
    colItem[c] = (kalimaByOrder.get(n) || {})._id || await getOrCreate('kalima', 'kalima', `Kalima ${n}`, n)
  } else if (c === 11) colItem[c] = await reuseOrCreate('Ayat ul Kursi', { track: 'kalima', type: 'component', order: 7 })
  else if (c === 12) colItem[c] = await reuseOrCreate('Eman e Mufassil', { track: 'kalima', type: 'component', order: 8 })
  else if (c === 13) colItem[c] = await reuseOrCreate('Eman e Mujmil', { track: 'kalima', type: 'component', order: 9 })
  else if (c === 14) colItem[c] = await reuseOrCreate('Dua-e-Qunoot', { track: 'namaz', type: 'component', order: 15 })
  else if (c === 15) colItem[c] = await getOrCreate('namaz', 'concept', 'Namaz', 100)
  else if (c === 16) colItem[c] = await getOrCreate('namaz', 'concept', 'Namaz e Janaza', 101)
  else if (c >= 17 && c <= 47) {                // Qaida Page 1-31
    const n = c - 16
    colItem[c] = (byLabel.get(`Qaida Page ${n}`) || {})._id || await getOrCreate('qaida', 'page', `Qaida Page ${n}`, n, { pageNumber: n })
  } else if (c >= 48 && c <= 77) {              // Quran Para 1-30
    const n = c - 47
    colItem[c] = (quranByPara.get(n) || {})._id || await getOrCreate('quran', 'para', `Para ${n}`, n, { paraNumber: n })
  } else if (c >= 78 && c <= 107) {             // 30 Urdu duas (create — sheet-faithful)
    const n = c - 77
    const urdu = label.replace(/^\d+\.\s*/, '').trim() // strip "12." prefix
    colItem[c] = await getOrCreate('dua', 'dua', urdu, n)
  } else if (c === 108) colItem[c] = await reuseOrCreate('Surah Yaseen', { track: 'hifz', type: 'surah', order: 1 })
  else if (c === 109) colItem[c] = await reuseOrCreate('Surah Al-Rahman', { track: 'hifz', type: 'surah', order: 2 })
  else if (c === 110) colItem[c] = await reuseOrCreate('Surah Mulk', { track: 'hifz', type: 'surah', order: 3 })
  else if (c === 111) colItem[c] = await getOrCreate('hifz', 'surah', 'Surah Al-Baqarah', 200)
  else if (c >= 112 && c <= 139) {              // Hifz 5-32 (generic in sheet)
    const n = c - 107 // 5..32
    colItem[c] = await getOrCreate('hifz', 'surah', `Hifz ${n}`, 200 + n)
  }
}
console.log(`Resolved ${Object.keys(colItem).length} lesson columns. Created ${createdItems.length} new curriculum items.`)

// ── Student lookup ──
const rollToId = new Map((await Student.find({}, 'rollNo').lean()).map(s => [s.rollNo, s._id]))

// ── Clear existing permanent lessons (re-runnable) ──
const cleared = await PermanentLesson.deleteMany({})
console.log(`Cleared ${cleared.deletedCount} existing permanent lessons.`)

// ── Aggregate: union each student's completions (earliest date wins) ──
const completion = new Map()        // `${studentId}|${itemId}` → earliest Date
const finishInfo = new Map()        // studentId → { ts, finishes:[..], auth }
let matchedRows = 0, unmatchedRegs = new Set()

for (let r = 3; r < rows.length; r++) {
  const reg = String(rows[r][COL.reg] || '').trim()
  if (!reg) continue
  const studentId = rollToId.get(reg)
  if (!studentId) { unmatchedRegs.add(reg); continue }
  matchedRows++

  for (let c = COL.firstLesson; c <= COL.lastLesson; c++) {
    if (!colItem[c]) continue
    const d = parseDate(rows[r][c])
    if (!d) continue
    const key = `${studentId}|${colItem[c]}`
    const prev = completion.get(key)
    if (!prev || d < prev) completion.set(key, d)
  }

  // Track finish dates + authorization from the latest submission per student.
  const ts = new Date(rows[r][COL.timestamp]) // form timestamp
  const sid = String(studentId)
  const cur = finishInfo.get(sid)
  if (!cur || (ts && ts > cur.ts)) {
    const finishes = []
    for (let c = COL.finishStart; c <= COL.finishEnd; c++) {
      const fd = parseDate(rows[r][c])
      if (fd) finishes.push(`${FINISH_LABELS[c - COL.finishStart]}: ${rows[r][c]}`)
    }
    finishInfo.set(sid, { ts: ts && !isNaN(ts) ? ts : new Date(0), finishes, auth: String(rows[r][146] || '').trim() })
  }
}
console.log(`Matched rows: ${matchedRows}. Unmatched regs: ${unmatchedRegs.size}.`)

// ── Bulk insert permanent lessons ──
const docs = []
for (const [key, date] of completion) {
  const [studentId, itemId] = key.split('|')
  docs.push({
    studentId, curriculumItemId: itemId, tutorId: placeholderTutor._id,
    completedDate: date, status: 'approved',
    notes: 'Imported from Students Permanent Data',
  })
}
let inserted = 0
for (let i = 0; i < docs.length; i += 1000) {
  const batch = docs.slice(i, i + 1000)
  await PermanentLesson.insertMany(batch, { ordered: false })
  inserted += batch.length
}
console.log(`Inserted ${inserted} permanent lessons for ${new Set([...completion.keys()].map(k => k.split('|')[0])).size} students.`)

// ── Fold Quran-finish dates into student notes ──
let noted = 0
for (const [sid, info] of finishInfo) {
  if (!info.finishes.length) continue
  await Student.updateOne({ _id: sid }, { $set: { notes: `Quran completed — ${info.finishes.join('; ')}` } })
  noted++
}
console.log(`Updated notes with Quran-finish dates for ${noted} students.`)

console.log('\n─────────── Permanent import summary ───────────')
console.log(`Curriculum items created : ${createdItems.length}`)
if (createdItems.length) console.log('  ' + createdItems.slice(0, 40).join(', ') + (createdItems.length > 40 ? ' …' : ''))
console.log(`Permanent lessons        : ${await PermanentLesson.countDocuments()}`)
console.log(`Students with lessons    : ${new Set([...completion.keys()].map(k => k.split('|')[0])).size}`)
console.log(`Placeholder tutor        : ${placeholderTutor.tutorId} (${placeholderTutor._id})`)

await mongoose.disconnect()
console.log('DONE')

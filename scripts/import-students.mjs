// Import students from "Students Data.xlsx" (Student Data sheet).
//   • Wipes existing students + related data first (fully reversible/re-runnable)
//   • Creates one Family per distinct Khandan ID, links students as members
//   • rollNo = Reg #; duplicate reg numbers get a letter suffix (HID467 → HID467B)
//   • Creates a portal login account for every student that is NOT "Left"
//       email = <regNo>@hidaya.online (lowercase), password = SHARED_PASSWORD
//
// Run from hidayah-backend:  node scripts/import-students.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import path from 'path'
import xlsx from 'xlsx'
import {
  loadAllModels, wipeStudentUniverse, parseDate, mapStatus,
  mapTimezone, mapSect, mapPlacement, mapSpecialNeeds,
} from './students-lib.mjs'

const BE = process.cwd()
const XLSX_PATH = process.env.STUDENTS_XLSX || path.resolve(BE, '..', 'Students Data.xlsx')
const SHEET = 'Student Data'
const EMAIL_DOMAIN = 'hidaya.online'
const SHARED_PASSWORD = 'Hidaya@123'

// Column indexes in the Student Data sheet (0-based).
const C = { reg: 0, name: 1, status: 2, joining: 3, khandan: 5, startedFrom: 7, sect: 8, disability: 9, tz: 10, special: 11, email: 12, country: 14 }

await mongoose.connect(process.env.MONGODB_URI)
console.log(`Connected. Reading ${XLSX_PATH}`)

const wb = xlsx.readFile(XLSX_PATH)
const ws = wb.Sheets[SHEET]
if (!ws) throw new Error(`Sheet "${SHEET}" not found. Sheets: ${wb.SheetNames.join(', ')}`)
const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })

// Collect valid student rows (must have a Reg #).
const records = []
for (let i = 1; i < rows.length; i++) {
  const reg = String(rows[i][C.reg] || '').trim()
  if (!reg) continue
  records.push({ row: i, cells: rows[i] })
}
console.log(`Found ${records.length} student rows in the sheet.`)

await loadAllModels(BE)
const Student = mongoose.model('Student')
const Family = mongoose.model('Family')
const User = mongoose.model('User')
const Role = mongoose.model('Role')
const StudentStatusHistory = mongoose.model('StudentStatusHistory')

const studentRole = await Role.findOne({ key: 'student' })
if (!studentRole) throw new Error('Student role not found — run the portal seed first.')

console.log('\nWiping existing student data (reversible precondition)…')
await wipeStudentUniverse({ log: console.log })

// ── Families: one per distinct Khandan ID ──
const famCodes = [...new Set(records.map(r => String(r.cells[C.khandan] || '').trim().toUpperCase()).filter(Boolean))]
const familyByCode = new Map()
for (const code of famCodes) {
  const fam = await Family.create({ familyCode: code, members: [] })
  familyByCode.set(code, fam)
}
console.log(`Created ${familyByCode.size} families.`)

// ── Students + accounts ──
const usedRoll = new Set()
const suffixLetters = ['B', 'C', 'D', 'E', 'F']
function uniqueRoll(reg) {
  if (!usedRoll.has(reg)) { usedRoll.add(reg); return reg }
  for (const L of suffixLetters) {
    const cand = reg + L
    if (!usedRoll.has(cand)) { usedRoll.add(cand); return cand }
  }
  throw new Error(`Cannot disambiguate roll number ${reg}`)
}

let created = 0, accounts = 0, noAccount = 0
const suffixed = []
const accountRows = [] // for the credentials report

for (const { cells } of records) {
  const reg = String(cells[C.reg] || '').trim()
  const rollNo = uniqueRoll(reg)
  if (rollNo !== reg) suffixed.push({ reg, rollNo, name: String(cells[C.name] || '').trim() })

  const status = mapStatus(cells[C.status])
  const famCode = String(cells[C.khandan] || '').trim().toUpperCase()
  const family = famCode ? familyByCode.get(famCode) : null

  const student = await Student.create({
    rollNo,
    name: String(cells[C.name] || '').trim(),
    status,
    joiningDate: parseDate(cells[C.joining]) || undefined,
    country: String(cells[C.country] || '').trim(),
    timezone: mapTimezone(cells[C.tz]),
    sect: mapSect(cells[C.sect]),
    placementLevel: mapPlacement(cells[C.startedFrom]),
    specialNeeds: mapSpecialNeeds(cells[C.disability], cells[C.special]),
    familyId: family ? family._id : undefined,
  })
  created++

  if (family) await Family.updateOne({ _id: family._id }, { $addToSet: { members: student._id } })

  await StudentStatusHistory.create({
    studentId: student._id,
    status,
    effectiveDate: student.joiningDate || new Date(),
    comment: 'Imported from Students Data.xlsx',
  })

  // Portal account for everyone who is NOT left.
  if (status !== 'left') {
    const email = `${rollNo.toLowerCase()}@${EMAIL_DOMAIN}`
    const user = await User.create({
      email,
      password: SHARED_PASSWORD,
      displayName: student.name,
      roles: [studentRole._id],
      status: 'active',
      linkedStudentId: student._id,
    })
    student.userId = user._id
    await student.save()
    accounts++
    accountRows.push({ rollNo, name: student.name, email })
  } else {
    noAccount++
  }
}

// ── Report ──
console.log('\n─────────── Import summary ───────────')
console.log(`Families created : ${familyByCode.size}`)
console.log(`Students created : ${created}`)
console.log(`Accounts created : ${accounts}  (password: ${SHARED_PASSWORD})`)
console.log(`Left (no account): ${noAccount}`)
if (suffixed.length) {
  console.log(`\nDuplicate reg numbers suffixed (${suffixed.length}):`)
  for (const s of suffixed) console.log(`  ${s.reg} → ${s.rollNo}  (${s.name})`)
}

// Write a credentials CSV report to the scratchpad-style docs folder.
const reportPath = path.resolve(BE, 'scripts', 'imported-accounts.csv')
const csv = ['rollNo,name,email,password',
  ...accountRows.map(r => `${r.rollNo},"${r.name.replace(/"/g, '""')}",${r.email},${SHARED_PASSWORD}`)].join('\n')
const { writeFileSync } = await import('fs')
writeFileSync(reportPath, csv)
console.log(`\nAccount credentials written to ${reportPath}`)

console.log(`\nVerify → Students: ${await Student.countDocuments()}, Families: ${await Family.countDocuments()}, Student accounts: ${await User.countDocuments({ linkedStudentId: { $ne: null } })}`)

await mongoose.disconnect()
console.log('DONE')

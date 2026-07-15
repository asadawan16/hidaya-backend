// Shared helpers for the student Excel import + its reversible reset.
// The wipe auto-detects every Student reference across all registered models,
// so the reset is a true inverse of the import and can be re-run any number of times.
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import mongoose from 'mongoose'

// Import every model file so mongoose.modelNames() is fully populated.
export async function loadAllModels(beDir) {
  const dir = path.join(beDir, 'models')
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.js')) await import(pathToFileURL(path.join(dir, f)).href)
  }
}

// Every top-level path on a schema that references the Student model
// (single ObjectId ref or an array of ObjectId refs).
function studentRefPaths(schema) {
  const out = []
  schema.eachPath((name, type) => {
    if (type?.options?.ref === 'Student') out.push(name)
    else if (type?.caster?.options?.ref === 'Student') out.push(name)
  })
  return out
}

// Delete all students, all families, every student portal account, and every
// document in any collection that references a student. Returns a per-model
// count report. Safe to run when there is nothing to delete.
export async function wipeStudentUniverse({ log = () => {} } = {}) {
  const Student = mongoose.model('Student')
  const studentIds = (await Student.find({}, { _id: 1 }).lean()).map(s => s._id)
  const report = {}

  if (studentIds.length) {
    for (const name of mongoose.modelNames()) {
      if (name === 'Student' || name === 'Family') continue
      const M = mongoose.model(name)
      const paths = studentRefPaths(M.schema)
      if (!paths.length) continue
      const filter = paths.length === 1
        ? { [paths[0]]: { $in: studentIds } }
        : { $or: paths.map(p => ({ [p]: { $in: studentIds } })) }
      const { deletedCount } = await M.deleteMany(filter)
      if (deletedCount) report[name] = deletedCount
    }
  }

  // Families are student containers — remove them wholesale.
  const fam = await mongoose.model('Family').deleteMany({})
  if (fam.deletedCount) report.Family = fam.deletedCount

  const stu = await Student.deleteMany({})
  report.Student = stu.deletedCount

  for (const [k, v] of Object.entries(report)) log(`  wiped ${v} ${k}`)
  return report
}

// ── Excel value mappers ────────────────────────────────────────────────

export function parseDate(v) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/) // M/D/YY(YY)
  if (m) {
    let [, mo, d, y] = m; y = +y; if (y < 100) y += 2000
    return new Date(Date.UTC(y, +mo - 1, +d))
  }
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/) // DD-MMM-YY
  if (m) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
    let [, d, mon, y] = m; y = +y; if (y < 100) y += 2000
    const mi = months[mon.toLowerCase()]
    if (mi == null) return null
    return new Date(Date.UTC(y, mi, +d))
  }
  const dt = new Date(s)
  return isNaN(dt) ? null : dt
}

export function mapStatus(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (s === 'left') return 'left'
  if (s === 'leave') return 'leave'
  if (s === 'active') return 'active'
  return 'active' // blank status → treat as active (recent joiners)
}

const TZ = {
  EST: 'America/New_York',
  CST: 'America/Chicago',
  MST: 'America/Denver',
  PST: 'America/Los_Angeles',
  UK: 'Europe/London',
  EUR: 'Europe/Berlin',
}
export function mapTimezone(raw) {
  const s = String(raw || '').trim().toUpperCase()
  return TZ[s] || 'Asia/Karachi'
}

export function mapSect(raw) {
  const s = String(raw || '').trim()
  if (s === 'سنی') return 'sunni'
  if (s === 'شیعہ') return 'shia'
  return ''
}

export function mapPlacement(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  if (s.includes('forgot')) return 'quran_forgot'
  if (s.includes('quran good')) return 'quran_good'
  if (s.includes('quran')) return 'quran_weak'
  if (s.includes('qaida but weak') || s.includes('qaida weak')) return 'qaida_weak'
  if (s.includes('qaida')) return 'qaida_basic'
  if (s.includes('beginn')) return 'beginning'
  return ''
}

export function mapSpecialNeeds(disability, special) {
  const parts = [disability, special].map(x => String(x || '').trim()).filter(Boolean)
  const joined = parts.join(' ').toLowerCase()
  if (!parts.length || joined === 'nill' || joined === 'nil' || joined === 'none') return []
  const note = parts.filter(p => p.toLowerCase() !== 'nill').join(' — ')
  if (joined.includes('autism')) return [{ type: 'autism', note }]
  if (joined.includes('speech')) return [{ type: 'speech', note }]
  if (joined.includes('learn')) return [{ type: 'learning_difficulty', note }]
  return [{ type: 'other', note }]
}

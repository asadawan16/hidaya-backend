// Reset FUTURE class sessions of the current shift that a tutor wrongly marked
// completed/missed BEFORE the class started, back to 'scheduled'.
//
// Safety model: a session is only touched when its real class-start instant is
// still in the FUTURE (start > now). Past and in-progress sessions are NEVER
// affected. Scope is limited to the shift currently in progress (8 PM → next-day
// 7 AM, Asia/Karachi), matching the board.
//
// Usage (from hidayah-backend/):
//   node scripts/reset-future-actioned-sessions.mjs           # DRY RUN (default)
//   node scripts/reset-future-actioned-sessions.mjs --apply   # actually reset
//
// Reads MONGODB_URI from .env.

import 'dotenv/config'
import mongoose from 'mongoose'
import ClassSession from '../models/ClassSession.js'
import LessonEntry from '../models/LessonEntry.js'
import '../models/Student.js'
import '../models/TutorProfile.js'

const APPLY = process.argv.includes('--apply')

// ── Asia/Karachi shift helpers (fixed UTC+5, no DST) ──
const SHIFT_WRAP_HOUR = 7
const PKT_OFFSET_MIN = 5 * 60
const pad = (n) => String(n).padStart(2, '0')

const addDaysStr = (iso, n) => {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const karachiDateStr = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(now)
const karachiHour = (now = new Date()) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', hour12: false }).format(now)) % 24
const currentShiftDate = (now = new Date()) => {
  const dateStr = karachiDateStr(now)
  return karachiHour(now) < SHIFT_WRAP_HOUR ? addDaysStr(dateStr, -1) : dateStr
}
// PKT calendar day of a stored session.date (midnight-UTC of the physical day).
const sessionDateStr = (d) => new Date(d).toISOString().slice(0, 10)
// Absolute epoch ms of a PKT wall-clock 'HH:MM' on a PKT calendar day.
const pktWallMs = (dateStr, hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  if (!Number.isFinite(h)) return null
  return Date.parse(`${dateStr}T00:00:00Z`) + ((h * 60 + (m || 0)) - PKT_OFFSET_MIN) * 60000
}
const fmtPkt = (ms) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi', weekday: 'short', day: '2-digit', month: 'short',
  hour: '2-digit', minute: '2-digit', hour12: true,
}).format(new Date(ms))

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set (.env)')
  await mongoose.connect(process.env.MONGODB_URI)

  const now = new Date()
  const nowMs = now.getTime()
  const shiftDate = currentShiftDate(now)
  const nextDate = addDaysStr(shiftDate, 1)
  const shiftStartMs = pktWallMs(shiftDate, '20:00')                 // 8:00 PM PKT
  const shiftEndMs = pktWallMs(nextDate, `${pad(SHIFT_WRAP_HOUR)}:00`) // next day 7:00 AM PKT

  console.log(`=== Reset future-actioned sessions ${APPLY ? '— APPLYING' : '(DRY RUN)'} ===`)
  console.log('Now (PKT):         ', fmtPkt(nowMs))
  console.log('Shift day:         ', shiftDate, `(8:00 PM → ${nextDate} 7:00 AM PKT)`)
  console.log('Rule:               reset ONLY sessions that are still in the FUTURE (start > now),')
  console.log('                    within this shift, and currently completed/missed.')
  console.log('                    Past / in-progress sessions are never touched.\n')

  // Candidate window: any physical date the shift can span, terminal status only.
  const rangeStart = new Date(`${shiftDate}T00:00:00.000Z`)
  const rangeEnd = new Date(`${addDaysStr(nextDate, 1)}T00:00:00.000Z`)
  const candidates = await ClassSession.find({
    status: { $in: ['completed', 'missed'] },
    date: { $gte: rangeStart, $lt: rangeEnd },
  })
    .populate('studentId', 'name rollNo')
    .populate('tutorId', 'name tutorId')
    .lean()

  const targets = []
  let pastSkipped = 0
  for (const s of candidates) {
    const startMs = pktWallMs(sessionDateStr(s.date), s.scheduledStart)
    if (startMs == null) continue
    if (startMs < shiftStartMs || startMs > shiftEndMs) continue // outside this shift
    if (startMs <= nowMs) { pastSkipped++; continue }            // SAFETY: never touch past/ongoing
    targets.push({ s, startMs })
  }
  targets.sort((a, b) => a.startMs - b.startMs)

  console.log(`Terminal (completed/missed) sessions in shift range: ${candidates.length}`)
  console.log(`  ↳ past/in-progress skipped (protected):            ${pastSkipped}`)
  console.log(`  ↳ FUTURE sessions to reset:                        ${targets.length}\n`)

  if (targets.length === 0) {
    console.log('Nothing to reset.')
  } else {
    for (const { s, startMs } of targets) {
      console.log(` • ${fmtPkt(startMs)}  ${s.scheduledStart}-${s.scheduledEnd}  [${String(s.status).toUpperCase()}]  `
        + `${s.studentId?.name || '?'} (${s.studentId?.rollNo || ''})  `
        + `tutor ${s.tutorId?.name || '?'}${s.tutorId?.tutorId ? ` (${s.tutorId.tutorId})` : ''}  `
        + `lesson:${s.lessonEntryId ? 'yes' : 'no'}  _id=${s._id}`)
    }
  }

  if (!APPLY) {
    console.log('\nDRY RUN — no changes made. Re-run with --apply to reset the sessions listed above.')
    await mongoose.disconnect()
    return
  }

  let reset = 0
  let lessonsDeleted = 0
  for (const { s } of targets) {
    if (s.lessonEntryId) {
      const r = await LessonEntry.deleteOne({ _id: s.lessonEntryId })
      lessonsDeleted += r.deletedCount || 0
    }
    await ClassSession.updateOne({ _id: s._id }, {
      $set: { status: 'scheduled', attendance: '' },
      $unset: { tutorStartedAt: '', actualStudentJoinTime: '', computedDuration: '', autoEndedAt: '', lessonEntryId: '' },
    })
    reset++
  }
  console.log(`\nAPPLIED ✔  reset ${reset} session(s) → 'scheduled'; deleted ${lessonsDeleted} orphan lesson entr${lessonsDeleted === 1 ? 'y' : 'ies'}.`)
  await mongoose.disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })

// Snapshot / restore of the timetable's TIMES — every ClassSlot's day + start, and
// every not-yet-started ClassSession's date + start/end. Take one before flipping
// the daylight-saving switch on live data; if anything looks wrong afterwards,
// restore puts every time back exactly as it was.
//
//   node scripts/schedule-times-snapshot.mjs
//       READ-ONLY. Writes backups/schedule-times-<timestamp>.json.
//   node scripts/schedule-times-snapshot.mjs --restore backups/schedule-times-….json
//       Dry run: prints how many rows differ from the snapshot. Writes nothing.
//   node scripts/schedule-times-snapshot.mjs --restore <file> --apply
//       Writes the snapshot's times back, and the DST flag it was taken with.
//       Sessions that were started / completed since are left alone (history).
//
// Uses MONGODB_URI from .env — check which database that is before --apply.
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import mongoose from 'mongoose'
import ClassSlot from '../models/ClassSlot.js'
import ClassSession from '../models/ClassSession.js'
import ScheduleConfig from '../models/ScheduleConfig.js'

const args = process.argv.slice(2)
const restoreIdx = args.indexOf('--restore')
const restoreFile = restoreIdx >= 0 ? args[restoreIdx + 1] : null
const apply = args.includes('--apply')

await mongoose.connect(process.env.MONGODB_URI)
console.log(`database: ${mongoose.connection.name}`)

try {
  if (!restoreFile) {
    const [slots, sessions, cfg] = await Promise.all([
      ClassSlot.find({}).select('dayOfWeek startTime dstShifted').lean(),
      ClassSession.find({ status: 'scheduled' }).select('date scheduledStart scheduledEnd dstShifted').lean(),
      ScheduleConfig.findOne({ key: 'default' }).select('dstActive').lean(),
    ])
    const dir = path.resolve('backups')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `schedule-times-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(file, JSON.stringify({
      takenAt: new Date().toISOString(),
      database: mongoose.connection.name,
      dstActive: !!cfg?.dstActive,
      slots: slots.map(s => ({ _id: String(s._id), dayOfWeek: s.dayOfWeek, startTime: s.startTime, dstShifted: !!s.dstShifted })),
      sessions: sessions.map(s => ({ _id: String(s._id), date: s.date, scheduledStart: s.scheduledStart, scheduledEnd: s.scheduledEnd, dstShifted: !!s.dstShifted })),
    }))
    console.log(`snapshot: ${slots.length} slots, ${sessions.length} scheduled sessions, dstActive=${!!cfg?.dstActive}`)
    console.log(`written to ${file}`)
  } else {
    const snap = JSON.parse(fs.readFileSync(restoreFile, 'utf8'))
    if (snap.database !== mongoose.connection.name) {
      throw new Error(`snapshot is from "${snap.database}" but connected to "${mongoose.connection.name}"`)
    }
    const slotIds = snap.slots.map(s => s._id)
    const sessionIds = snap.sessions.map(s => s._id)
    const [slotsNow, sessionsNow] = await Promise.all([
      ClassSlot.find({ _id: { $in: slotIds } }).select('dayOfWeek startTime dstShifted').lean(),
      ClassSession.find({ _id: { $in: sessionIds }, status: 'scheduled' }).select('date scheduledStart scheduledEnd dstShifted').lean(),
    ])
    const slotNow = new Map(slotsNow.map(s => [String(s._id), s]))
    const sessNow = new Map(sessionsNow.map(s => [String(s._id), s]))

    const slotOps = []
    for (const s of snap.slots) {
      const cur = slotNow.get(s._id)
      if (!cur) continue // deleted since
      if (cur.dayOfWeek === s.dayOfWeek && cur.startTime === s.startTime && !!cur.dstShifted === s.dstShifted) continue
      slotOps.push({ updateOne: { filter: { _id: s._id }, update: { $set: { dayOfWeek: s.dayOfWeek, startTime: s.startTime, dstShifted: s.dstShifted } } } })
    }
    const sessionOps = []
    for (const s of snap.sessions) {
      const cur = sessNow.get(s._id)
      if (!cur) continue // started / completed / deleted since — history, leave it
      const same = new Date(cur.date).getTime() === new Date(s.date).getTime()
        && cur.scheduledStart === s.scheduledStart && cur.scheduledEnd === s.scheduledEnd && !!cur.dstShifted === s.dstShifted
      if (same) continue
      sessionOps.push({
        updateOne: {
          filter: { _id: s._id, status: 'scheduled' },
          update: { $set: { date: new Date(s.date), scheduledStart: s.scheduledStart, scheduledEnd: s.scheduledEnd, dstShifted: s.dstShifted } },
        },
      })
    }
    console.log(`snapshot taken ${snap.takenAt} (dstActive=${snap.dstActive})`)
    console.log(`differs now: ${slotOps.length} slots, ${sessionOps.length} sessions`)
    if (!apply) {
      console.log('dry run — nothing written. Add --apply to restore.')
    } else {
      if (slotOps.length) await ClassSlot.bulkWrite(slotOps, { ordered: false })
      if (sessionOps.length) await ClassSession.bulkWrite(sessionOps, { ordered: false })
      await ScheduleConfig.updateOne({ key: 'default' }, { $set: { dstActive: snap.dstActive } }, { upsert: true })
      console.log(`restored ${slotOps.length} slots, ${sessionOps.length} sessions, dstActive=${snap.dstActive}`)
    }
  }
} finally {
  await mongoose.disconnect()
}

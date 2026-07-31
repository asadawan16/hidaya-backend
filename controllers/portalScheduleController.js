import ClassSlot from '../models/ClassSlot.js'
import ClassSession from '../models/ClassSession.js'
import ScheduleConfig from '../models/ScheduleConfig.js'
import Student from '../models/Student.js'
import TutorProfile from '../models/TutorProfile.js'
import User from '../models/User.js'
import { logActivity } from '../utils/activityLogger.js'
import { createNotification, notifyRoles } from './portalNotificationController.js'
import { emitToLiveBoard } from '../config/socket.js'

// A started class is auto-completed once it has run this many minutes past its
// scheduled start (classes are ~30 min, so 50 min means it's clearly over-running
// and was likely left open). Oversight + the tutor are notified.
export const AUTO_COMPLETE_AFTER_MIN = 50

const DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

// Current date info in a given timezone (default Asia/Karachi), server-TZ independent.
export function tzDateInfo(base = new Date(), timeZone = 'Asia/Karachi') {
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(base)
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(base)
  return { dateStr, dayOfWeek: DOW_MAP[weekday] }
}

// Weekday (0-6) of a 'YYYY-MM-DD' date string, independent of server timezone.
function dayOfWeekOf(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`)
  return d.getUTCDay()
}

// ── Overnight "shift-day" model ──
// A teaching shift is labelled by the day it STARTS but physically runs
// ~8 PM (PKT) → 7 AM the next calendar day (foreign-student hours). A class whose
// start time is in the after-midnight tail (before SHIFT_WRAP_HOUR) therefore
// occurs on the *next* calendar day even though it belongs to the starting day's
// shift. This matches the board's night-window end so the two stay aligned.
export const SHIFT_WRAP_HOUR = 7 // 00:00–06:59 is the previous day's overnight tail

// Is this 'HH:MM' start time in the after-midnight tail of a shift?
const isAfterMidnightTail = (startTime) => {
  const [h] = String(startTime).split(':').map(Number)
  return Number.isFinite(h) && h < SHIFT_WRAP_HOUR
}

// 'YYYY-MM-DD' + n days (UTC-anchored so it never drifts with server TZ).
const addDaysStr = (iso, n) => {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Physical calendar date a slot's session falls on, given its shift-day date:
// evening/daytime → same day; after-midnight tail → the next calendar day.
const physicalDateForSlot = (shiftDateStr, startTime) =>
  isAfterMidnightTail(startTime) ? addDaysStr(shiftDateStr, 1) : shiftDateStr

// The shift-day currently in progress in Asia/Karachi: before 7 AM PKT we are
// still inside the previous calendar day's overnight shift.
export function currentShiftDate(base = new Date()) {
  const { dateStr, minutes } = karachiNow(base)
  return minutes < SHIFT_WRAP_HOUR * 60 ? addDaysStr(dateStr, -1) : dateStr
}

// Absolute instant (ms) a session's class actually starts. `session.date` is the
// midnight-UTC of the PKT calendar day the class physically falls on (after-midnight
// tail slots are already stored on the next day), and `scheduledStart` is an
// 'HH:MM' Asia/Karachi wall-clock time. PKT is a fixed UTC+5 (no DST), so the real
// start = PKT-day-midnight − 5h + scheduledStart.
function sessionStartMs(session) {
  const dateStr = tzDateInfo(session.date).dateStr
  const [h, m] = String(session.scheduledStart || '').split(':').map(Number)
  if (!Number.isFinite(h)) return null
  return Date.parse(`${dateStr}T00:00:00Z`) + ((h - 5) * 60 + (m || 0)) * 60000
}

// True when the class has not begun yet (with a small grace for clock skew).
// Used to stop tutors completing / missing / starting a *future* class — e.g. at
// 10:26 PM they must not action a class that starts at 1:00 AM on the same shift.
function sessionStartsInFuture(session, graceMin = 5) {
  const startMs = sessionStartMs(session)
  if (startMs == null) return false
  return startMs - graceMin * 60000 > Date.now()
}

// Create any missing sessions for the given date from active slots on that weekday.
// Idempotent (dedupes by slotId + date). Returns the number created.
export async function generateSessionsForDay(dateStr) {
  const dayOfWeek = dayOfWeekOf(dateStr)
  const slots = await ClassSlot.find({ dayOfWeek, active: true }).lean()
  if (slots.length === 0) return 0

  // After-midnight tail slots (00:00–06:59) physically land on the next calendar
  // day, so a single shift-day can produce sessions on two dates. Dedupe by
  // slotId + the session's *target* date across both candidate days.
  const nextDateStr = addDaysStr(dateStr, 1)
  const rangeStart = new Date(`${dateStr}T00:00:00.000Z`)
  const rangeEnd = new Date(`${nextDateStr}T23:59:59.999Z`)
  const existing = await ClassSession.find({
    slotId: { $in: slots.map(s => s._id) },
    date: { $gte: rangeStart, $lte: rangeEnd },
  }).select('slotId date').lean()
  const existingKeys = new Set(existing.map(s => `${s.slotId}|${tzDateInfo(s.date).dateStr}`))

  const toCreate = []
  for (const slot of slots) {
    const targetDate = physicalDateForSlot(dateStr, slot.startTime)
    if (existingKeys.has(`${slot._id}|${targetDate}`)) continue
    const [h, m] = slot.startTime.split(':').map(Number)
    const endMinutes = h * 60 + m + slot.durationMinutes
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`
    toCreate.push({
      slotId: slot._id,
      studentId: slot.studentId,
      tutorId: slot.tutorId,
      date: new Date(`${targetDate}T00:00:00.000Z`),
      scheduledStart: slot.startTime,
      scheduledEnd: endTime,
      status: 'scheduled',
    })
  }
  if (toCreate.length > 0) await ClassSession.insertMany(toCreate)
  return toCreate.length
}

// Background job: if enabled, generate today's (Asia/Karachi) sessions.
export async function runAutoSessionGeneration() {
  try {
    const cfg = await ScheduleConfig.findOne({ key: 'default' }).lean()
    if (cfg && cfg.autoGenerateSessions === false) return
    // Generate the shift currently in progress (before 7 AM PKT that's yesterday's
    // overnight shift), so a night shift's after-midnight tail is always ready.
    const dateStr = currentShiftDate()
    const created = await generateSessionsForDay(dateStr)
    if (created > 0) console.log(`[auto-sessions] generated ${created} session(s) for ${dateStr} shift`)
  } catch (err) {
    console.error('[auto-sessions] error:', err.message)
  }
}

// ── Capacity & double-booking ──
const DEFAULT_SKILL_CAPACITY = { beginner: 14, medium: 15, professional: 16, expert: 16 }
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Merge stored config over defaults so a missing/partial skillCapacity still resolves.
function resolveSkillCapacity(cfg) {
  const sc = (cfg && cfg.skillCapacity) || {}
  return {
    beginner: sc.beginner ?? DEFAULT_SKILL_CAPACITY.beginner,
    medium: sc.medium ?? DEFAULT_SKILL_CAPACITY.medium,
    professional: sc.professional ?? DEFAULT_SKILL_CAPACITY.professional,
    expert: sc.expert ?? DEFAULT_SKILL_CAPACITY.expert,
  }
}

// A tutor's max classes per shift-day: explicit per-tutor override, else the skill cap.
function effectiveCapacity(tutor, skillCap) {
  if (tutor && tutor.capacityOverride != null) return tutor.capacityOverride
  return skillCap[tutor?.skillLevel] ?? DEFAULT_SKILL_CAPACITY.beginner
}

// 'HH:MM' → minutes since midnight.
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

// Active-slot time clashes for the tutor and/or student on a weekday. Two slots
// clash when their [start, start+duration) minute ranges overlap.
async function findSlotConflicts({ dayOfWeek, startTime, durationMinutes, tutorId, studentId, excludeId }) {
  const newStart = toMinutes(startTime)
  const newEnd = newStart + (Number(durationMinutes) || 30)
  const filter = { active: true, dayOfWeek: Number(dayOfWeek), $or: [{ tutorId }, { studentId }] }
  if (excludeId) filter._id = { $ne: excludeId }
  const existing = await ClassSlot.find(filter).select('tutorId studentId startTime durationMinutes').lean()
  const conflicts = []
  for (const s of existing) {
    const sStart = toMinutes(s.startTime)
    const sEnd = sStart + (s.durationMinutes || 30)
    if (sStart < newEnd && newStart < sEnd) {
      if (String(s.tutorId) === String(tutorId)) conflicts.push({ type: 'tutor', slot: s })
      if (String(s.studentId) === String(studentId)) conflicts.push({ type: 'student', slot: s })
    }
  }
  return conflicts
}

// ─── ClassSlot CRUD ───

export async function listSlots(req, res) {
  try {
    const { tutorId, studentId, dayOfWeek, active } = req.query
    const filter = {}
    // Scope: students see only their own; a *plain* tutor sees only their own slots,
    // but a schedule.manage holder (oversight, incl. QCI) sees the whole schedule.
    const seesAll = req.userPermissions?.has('schedule.manage')
    if (req.user.linkedStudentId) {
      filter.studentId = req.user.linkedStudentId
    } else if (req.user.linkedTutorId && !seesAll) {
      filter.tutorId = req.user.linkedTutorId
      if (studentId) filter.studentId = studentId
    } else {
      if (tutorId) filter.tutorId = tutorId
      if (studentId) filter.studentId = studentId
    }
    if (dayOfWeek !== undefined) filter.dayOfWeek = Number(dayOfWeek)
    if (active !== undefined) filter.active = active === 'true'

    const query = () => ClassSlot.find(filter)
      .populate('studentId', 'name rollNo status performanceTags freshness leaveStartDate expectedResumeDate')
      .populate('tutorId', 'name tutorId meetLink')
      .sort({ dayOfWeek: 1, startTime: 1 })

    // Legacy callers (no ?page) get a flat array; paginated callers get an envelope.
    // Flat callers may request a larger cap — the week calendar needs every active
    // slot across all 7 days, which can exceed the 500 default. Clamp to 5000.
    if (!req.query.page) {
      const flatLimit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 500))
      const records = await query().limit(flatLimit).lean()
      return res.json(records)
    }

    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30))
    const total = await ClassSlot.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)
    const records = await query().skip((safePage - 1) * lim).limit(lim).lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List slots error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createSlot(req, res) {
  try {
    const { studentId, tutorId, track, tracks, dayOfWeek, days, startTime, durationMinutes, timezone, meetLink } = req.body
    if (!studentId || !tutorId || !startTime) {
      return res.status(400).json({ error: 'studentId, tutorId, and startTime are required' })
    }

    // Normalize track selection — accept a tracks[] array or a single track.
    const trackList = (Array.isArray(tracks) && tracks.length ? tracks : (track ? [track] : ['nazra']))
      .filter((t, i, a) => t && a.indexOf(t) === i)
    const primaryTrack = trackList[0] || 'nazra'

    // Determine which days to create slots for
    const daysToCreate = Array.isArray(days) && days.length > 0
      ? days.map(Number)
      : (dayOfWeek !== undefined ? [Number(dayOfWeek)] : [])

    if (daysToCreate.length === 0) {
      return res.status(400).json({ error: 'dayOfWeek or days array is required' })
    }

    // ── Validate all days first (create nothing on any conflict/capacity failure) ──
    const cfg = await ScheduleConfig.findOne({ key: 'default' }).lean()
    const skillCap = resolveSkillCapacity(cfg)
    const tutorDoc = await TutorProfile.findById(tutorId).select('skillLevel capacityOverride').lean()
    if (!tutorDoc) return res.status(400).json({ error: 'Tutor not found' })
    const cap = effectiveCapacity(tutorDoc, skillCap)
    const dur = durationMinutes || 30
    for (const dow of daysToCreate) {
      const conflicts = await findSlotConflicts({ dayOfWeek: dow, startTime, durationMinutes: dur, tutorId, studentId })
      const tutorClash = conflicts.find(c => c.type === 'tutor')
      const studentClash = conflicts.find(c => c.type === 'student')
      if (tutorClash) return res.status(409).json({ error: `Tutor already has a class at ${tutorClash.slot.startTime} on ${DAY_NAMES[dow]}` })
      if (studentClash) return res.status(409).json({ error: `Student already has a class at ${studentClash.slot.startTime} on ${DAY_NAMES[dow]}` })
      const used = await ClassSlot.countDocuments({ tutorId, dayOfWeek: dow, active: true })
      if (used >= cap) return res.status(409).json({ error: `Tutor at capacity (${used}/${cap} classes) for ${DAY_NAMES[dow]}` })
    }

    const createdSlots = []

    for (const dow of daysToCreate) {
      const slot = await ClassSlot.create({
        studentId, tutorId,
        track: primaryTrack,
        tracks: trackList,
        dayOfWeek: dow,
        startTime,
        durationMinutes: durationMinutes || 30,
        timezone: timezone || 'Asia/Karachi',
        meetLink: meetLink || '',
        active: true,
      })

      const populated = await ClassSlot.findById(slot._id)
        .populate('studentId', 'name rollNo status performanceTags freshness leaveStartDate expectedResumeDate')
        .populate('tutorId', 'name tutorId')
        .lean()

      createdSlots.push(populated)
    }

    // Materialise sessions for the shift currently in progress using the SAME
    // shift-aware, idempotent generator as the background job / "Generate Sessions"
    // button. This avoids the old per-slot auto-create which anchored the session to
    // the SERVER-LOCAL calendar day and could produce a duplicate document (dated
    // differently) for the same class — the source of "shown as live and due both".
    // generateSessionsForDay dedupes by slotId + target date, so re-running is safe.
    try {
      const cfgAuto = await ScheduleConfig.findOne({ key: 'default' }).lean()
      if (!cfgAuto || cfgAuto.autoGenerateSessions !== false) {
        await generateSessionsForDay(currentShiftDate())
      }
    } catch (genErr) {
      console.error('Auto-generate after slot create failed:', genErr.message)
    }

    await logActivity({
      level: 'info',
      category: 'schedule',
      action: 'slot_created',
      message: `${createdSlots.length} class slot(s) created: days [${daysToCreate.join(',')}] at ${startTime}`,
      req,
      meta: { slotIds: createdSlots.map(s => s._id) },
    })

    // Return single slot for backward compat, array if multiple
    res.status(201).json(createdSlots.length === 1 ? createdSlots[0] : createdSlots)
  } catch (err) {
    console.error('Create slot error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateSlot(req, res) {
  try {
    const slot = await ClassSlot.findById(req.params.id)
    if (!slot) return res.status(404).json({ error: 'Slot not found' })

    // Re-validate booking only when the schedule (day/time) changes or the slot is
    // being reactivated — pure meta edits (track, meetLink) skip the check.
    const schedulingChanged = ['dayOfWeek', 'startTime', 'durationMinutes'].some(f => req.body[f] !== undefined)
    const reactivating = req.body.active === true && slot.active === false
    if (schedulingChanged || reactivating) {
      const newDow = req.body.dayOfWeek !== undefined ? Number(req.body.dayOfWeek) : slot.dayOfWeek
      const newStart = req.body.startTime !== undefined ? req.body.startTime : slot.startTime
      const newDur = req.body.durationMinutes !== undefined ? req.body.durationMinutes : slot.durationMinutes
      const conflicts = await findSlotConflicts({ dayOfWeek: newDow, startTime: newStart, durationMinutes: newDur, tutorId: slot.tutorId, studentId: slot.studentId, excludeId: slot._id })
      const tutorClash = conflicts.find(c => c.type === 'tutor')
      const studentClash = conflicts.find(c => c.type === 'student')
      if (tutorClash) return res.status(409).json({ error: `Tutor already has a class at ${tutorClash.slot.startTime} on ${DAY_NAMES[newDow]}` })
      if (studentClash) return res.status(409).json({ error: `Student already has a class at ${studentClash.slot.startTime} on ${DAY_NAMES[newDow]}` })
      if (newDow !== slot.dayOfWeek) {
        const cfg = await ScheduleConfig.findOne({ key: 'default' }).lean()
        const tutorDoc = await TutorProfile.findById(slot.tutorId).select('skillLevel capacityOverride').lean()
        const cap = effectiveCapacity(tutorDoc, resolveSkillCapacity(cfg))
        const used = await ClassSlot.countDocuments({ tutorId: slot.tutorId, dayOfWeek: newDow, active: true, _id: { $ne: slot._id } })
        if (used >= cap) return res.status(409).json({ error: `Tutor at capacity (${used}/${cap} classes) for ${DAY_NAMES[newDow]}` })
      }
    }

    const fields = ['dayOfWeek', 'startTime', 'durationMinutes', 'timezone', 'meetLink', 'active', 'track']
    for (const f of fields) {
      if (req.body[f] !== undefined) slot[f] = req.body[f]
    }
    // Multi-track: keep track (primary) in sync with tracks[0].
    if (Array.isArray(req.body.tracks)) {
      const trackList = req.body.tracks.filter((t, i, a) => t && a.indexOf(t) === i)
      slot.tracks = trackList
      if (trackList.length) slot.track = trackList[0]
    }
    await slot.save()

    res.json(slot)
  } catch (err) {
    console.error('Update slot error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteSlot(req, res) {
  try {
    const slot = await ClassSlot.findById(req.params.id)
    if (!slot) return res.status(404).json({ error: 'Slot not found' })

    slot.active = false
    await slot.save()

    res.json({ message: 'Slot deactivated' })
  } catch (err) {
    console.error('Delete slot error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/schedule/slot-board?dayOfWeek= — tutor × time slot board for one
// weekday, with per-tutor capacity and an overall "spaces available" summary.
export async function getSlotBoard(req, res) {
  try {
    const dow = req.query?.dayOfWeek != null ? Number(req.query.dayOfWeek) : dayOfWeekOf(currentShiftDate())
    const cfg = await ScheduleConfig.findOne({ key: 'default' }).lean()
    const skillCap = resolveSkillCapacity(cfg)

    // Tutor columns — same scoping as listSlots/getBoard. Oversight (schedule.manage)
    // sees every tutor; a plain linked tutor sees only their own column.
    const seesAll = req.userPermissions?.has('schedule.manage')
    const tFilter = { status: 'active' }
    if (req.user.linkedTutorId && !seesAll) tFilter._id = req.user.linkedTutorId
    else if (req.query.tutorId) tFilter._id = req.query.tutorId
    const tutors = await TutorProfile.find(tFilter)
      .select('name tutorId skillLevel capacityOverride meetLink roomNo status')
      .lean()

    // Active slots for this weekday, scoped to the viewer.
    const slotFilter = { dayOfWeek: dow, active: true }
    if (req.user.linkedStudentId) slotFilter.studentId = req.user.linkedStudentId
    else if (req.user.linkedTutorId && !seesAll) slotFilter.tutorId = req.user.linkedTutorId
    const slots = await ClassSlot.find(slotFilter)
      .populate('studentId', 'name rollNo status')
      .sort({ startTime: 1 })
      .lean()
    const byTutor = {}
    for (const s of slots) {
      const k = String(s.tutorId)
      ;(byTutor[k] = byTutor[k] || []).push(s)
    }

    // Sort columns by numeric tutorId (T01, T02…).
    const num = (t) => parseInt(String(t.tutorId).replace(/\D/g, ''), 10) || 0
    tutors.sort((a, b) => num(a) - num(b))

    let totalCapacity = 0
    let totalUsed = 0
    const cols = tutors.map(t => {
      const mySlots = byTutor[String(t._id)] || []
      const capacity = effectiveCapacity(t, skillCap)
      const used = mySlots.length
      totalCapacity += capacity
      totalUsed += used
      return { ...t, capacity, used, available: Math.max(0, capacity - used), slots: mySlots }
    })

    res.json({
      dayOfWeek: dow,
      tutors: cols,
      summary: { totalCapacity, totalUsed, totalAvailable: Math.max(0, totalCapacity - totalUsed) },
      skillCapacity: skillCap,
    })
  } catch (err) {
    console.error('Get slot board error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── ClassSession ───

export async function listSessions(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30))
    const { tutorId, studentId, date, dateFrom, dateTo, status, sort } = req.query

    const filter = {}
    // Scope: students see only their own; a *plain* tutor sees only their own
    // sessions, but a schedule.manage holder (oversight, incl. QCI) sees all.
    const seesAll = req.userPermissions?.has('schedule.manage')
    if (req.user.linkedStudentId) {
      filter.studentId = req.user.linkedStudentId
    } else if (req.user.linkedTutorId && !seesAll) {
      filter.tutorId = req.user.linkedTutorId
      if (studentId) filter.studentId = studentId
    } else {
      if (tutorId) filter.tutorId = tutorId
      if (studentId) filter.studentId = studentId
    }
    if (status) filter.status = status
    if (date) {
      const d = new Date(date)
      filter.date = { $gte: new Date(d.setHours(0, 0, 0, 0)), $lt: new Date(d.setHours(23, 59, 59, 999)) }
    }
    if (dateFrom || dateTo) {
      filter.date = {}
      if (dateFrom) filter.date.$gte = new Date(dateFrom)
      if (dateTo) filter.date.$lte = new Date(dateTo)
    }

    // Night-shift support: when a wrapping window is requested (startHour > endHour,
    // e.g. 20:00 → 07:00) alongside a single `date`, also pull the *next* calendar
    // day's early-morning sessions (before endHour) and tag them dayOffset=1, so an
    // overnight class's post-midnight tail shows on the night it belongs to. Mirrors
    // getBoard. Only active with `date` + wrap params, so other callers are unaffected.
    const startHour = req.query.startHour != null ? parseInt(req.query.startHour, 10) : null
    const endHour = req.query.endHour != null ? parseInt(req.query.endHour, 10) : null
    const wraps = date && startHour != null && endHour != null && startHour > endHour

    let sortObj = { date: -1, scheduledStart: -1 }
    if (sort === 'date') sortObj = { date: 1, scheduledStart: 1 }
    if (sort === 'status') sortObj = { status: 1, date: -1 }

    const studentSel = 'name rollNo status performanceTags freshness leaveStartDate expectedResumeDate'

    if (wraps) {
      // Unpaginated night view: the day's sessions + next-day early tail.
      const records = await ClassSession.find(filter)
        .populate('studentId', studentSel)
        .populate('tutorId', 'name tutorId')
        .populate('slotId', 'track meetLink')
        .sort(sortObj)
        .lean()
      records.forEach(s => { s.dayOffset = 0 })

      const nextStart = new Date(date); nextStart.setDate(nextStart.getDate() + 1); nextStart.setHours(0, 0, 0, 0)
      const nextEnd = new Date(nextStart); nextEnd.setHours(23, 59, 59, 999)
      const cutoff = String(endHour).padStart(2, '0') + ':00'
      const nextFilter = { ...filter, date: { $gte: nextStart, $lt: nextEnd } }
      let nextSessions = await ClassSession.find(nextFilter)
        .populate('studentId', studentSel)
        .populate('tutorId', 'name tutorId')
        .populate('slotId', 'track meetLink')
        .sort(sortObj)
        .lean()
      nextSessions = nextSessions.filter(s => s.scheduledStart && s.scheduledStart < cutoff)
      nextSessions.forEach(s => { s.dayOffset = 1 })

      const combined = records.concat(nextSessions)
      return res.json({ records: combined, total: combined.length, page: 1, pages: 1 })
    }

    const total = await ClassSession.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await ClassSession.find(filter)
      .populate('studentId', studentSel)
      .populate('tutorId', 'name tutorId')
      .populate('slotId', 'track meetLink')
      .sort(sortObj)
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List sessions error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createSession(req, res) {
  try {
    const { slotId, studentId, tutorId, date, scheduledStart, scheduledEnd } = req.body
    if (!studentId || !tutorId || !date || !scheduledStart || !scheduledEnd) {
      return res.status(400).json({ error: 'studentId, tutorId, date, scheduledStart, and scheduledEnd are required' })
    }

    const session = await ClassSession.create({
      slotId, studentId, tutorId,
      date: new Date(date),
      scheduledStart, scheduledEnd,
      status: 'scheduled',
    })

    res.status(201).json(session)
  } catch (err) {
    console.error('Create session error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function startSession(req, res) {
  try {
    const session = await ClassSession.findById(req.params.id)
    if (!session) return res.status(404).json({ error: 'Session not found' })
    if (session.status !== 'scheduled') return res.status(400).json({ error: 'Session cannot be started' })

    // Tutors may only act on a class once its scheduled time has arrived. Managers
    // (schedule.manage) can override for corrections.
    const canOverrideTime = req.userPermissions?.has('schedule.manage')
    if (!canOverrideTime && sessionStartsInFuture(session)) {
      return res.status(400).json({ error: 'This class has not started yet — you can only start it once its scheduled time begins.' })
    }

    session.status = 'started'
    session.tutorStartedAt = new Date()
    await session.save()

    emitToLiveBoard('live_board_changed', { action: 'started', sessionId: session._id })

    res.json(session)
  } catch (err) {
    console.error('Start session error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function completeSession(req, res) {
  try {
    const session = await ClassSession.findById(req.params.id)
    if (!session) return res.status(404).json({ error: 'Session not found' })

    // Block completing a class that has not started yet (managers can override).
    const canOverrideTime = req.userPermissions?.has('schedule.manage')
    if (!canOverrideTime && sessionStartsInFuture(session)) {
      return res.status(400).json({ error: 'This class has not started yet — you cannot complete a future class.' })
    }

    const { attendance, actualStudentJoinTime, notes, lesson } = req.body

    session.status = 'completed'
    session.autoEndedAt = new Date()
    if (attendance) session.attendance = attendance
    if (notes) session.notes = notes

    if (actualStudentJoinTime) {
      session.actualStudentJoinTime = new Date(actualStudentJoinTime)
      const endParts = session.scheduledEnd.split(':').map(Number)
      const joinTime = new Date(actualStudentJoinTime)
      const endMinutes = endParts[0] * 60 + endParts[1]
      const joinMinutes = joinTime.getHours() * 60 + joinTime.getMinutes()
      session.computedDuration = Math.max(0, endMinutes - joinMinutes)
    }

    // Create lesson entry if provided
    if (lesson && lesson.items?.length > 0) {
      const LessonEntry = (await import('../models/LessonEntry.js')).default
      const entry = await LessonEntry.create({
        sessionId: session._id,
        studentId: session.studentId,
        tutorId: session.tutorId,
        date: session.date,
        classStart: session.scheduledStart,
        classEnd: session.scheduledEnd,
        kind: lesson.kind || 'daily',
        items: lesson.items,
        customText: lesson.customText || '',
        notes: lesson.notes || '',
      })
      session.lessonEntryId = entry._id
      // A lesson was logged — clear the "needs lesson" flag set by auto/force complete.
      session.needsLessonLog = false
    }

    await session.save()

    emitToLiveBoard('live_board_changed', { action: 'completed', sessionId: session._id })

    await logActivity({
      level: 'info',
      category: 'schedule',
      action: 'session_completed',
      message: `Session completed: ${session._id}, attendance: ${attendance}`,
      req,
      meta: { sessionId: session._id },
    })

    res.json(session)
  } catch (err) {
    console.error('Complete session error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function markSessionMissed(req, res) {
  try {
    const session = await ClassSession.findById(req.params.id)
    if (!session) return res.status(404).json({ error: 'Session not found' })

    // Block marking a not-yet-started class as missed (managers can override).
    const canOverrideTime = req.userPermissions?.has('schedule.manage')
    if (!canOverrideTime && sessionStartsInFuture(session)) {
      return res.status(400).json({ error: 'This class has not started yet — you cannot mark a future class as missed.' })
    }

    session.status = 'missed'
    session.attendance = 'no_show'
    session.notes = req.body.notes || ''
    await session.save()

    // Notify tutor + student about the missed session
    const when = session.date ? new Date(session.date).toLocaleDateString() : 'recently'
    const tutorU = await User.findOne({ linkedTutorId: session.tutorId, status: 'active' }).select('_id').lean()
    if (tutorU) {
      await createNotification({
        userId: tutorU._id,
        type: 'session_missed',
        title: 'Class Marked Missed',
        body: `A class session on ${when} was marked as missed (student no-show).`,
        payload: { sessionId: session._id },
      })
    }
    const missedStudent = await Student.findById(session.studentId).select('userId').lean()
    if (missedStudent?.userId) {
      await createNotification({
        userId: missedStudent.userId,
        type: 'session_missed',
        title: 'Missed Class',
        body: `You missed your class on ${when}. Please contact your tutor to reschedule.`,
        payload: { sessionId: session._id },
      })
    }

    res.json(session)
  } catch (err) {
    console.error('Mark missed error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Reset a session back to 'scheduled' (super-admin corrective action) ───
// Tutors sometimes mark future/wrong classes complete or missed. This reverses a
// completed/missed/started session to a clean 'scheduled' state, clearing the
// completion metadata and removing any lesson entry that was created on completion.
export async function resetSession(req, res) {
  try {
    const session = await ClassSession.findById(req.params.id)
    if (!session) return res.status(404).json({ error: 'Session not found' })

    const prevStatus = session.status
    if (prevStatus === 'scheduled') {
      return res.status(400).json({ error: 'Session is already scheduled' })
    }

    // Drop the lesson entry created at completion so the reset leaves no orphan.
    if (session.lessonEntryId) {
      const LessonEntry = (await import('../models/LessonEntry.js')).default
      await LessonEntry.deleteOne({ _id: session.lessonEntryId })
      session.lessonEntryId = undefined
    }

    session.status = 'scheduled'
    session.attendance = ''
    session.tutorStartedAt = undefined
    session.actualStudentJoinTime = undefined
    session.computedDuration = undefined
    session.autoEndedAt = undefined
    await session.save()

    emitToLiveBoard('live_board_changed', { action: 'reset', sessionId: session._id })

    await logActivity({
      level: 'warning',
      category: 'schedule',
      action: 'session_reset',
      message: `Session ${session._id} reset from '${prevStatus}' to 'scheduled'`,
      req,
      meta: { sessionId: session._id, previousStatus: prevStatus },
    })

    res.json(session)
  } catch (err) {
    console.error('Reset session error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Edit a session's status / attendance (QCI & super-admin corrective action) ───
// Broader than resetSession: lets oversight set any valid status (scheduled/started/
// completed/missed) and/or attendance (on_time/late/no_show/none) to fix a mislabelled
// class. This is a pure state-label correction — unlike reset it does NOT create or
// delete lesson entries or touch timing metadata. Gated by schedule.session_status.
const SESSION_STATUS_VALUES = ['scheduled', 'started', 'completed', 'missed']
const SESSION_ATTENDANCE_VALUES = ['on_time', 'late', 'no_show', '']

export async function updateSessionStatus(req, res) {
  try {
    const { status, attendance } = req.body
    if (status === undefined && attendance === undefined) {
      return res.status(400).json({ error: 'Provide a status and/or attendance to set' })
    }
    if (status !== undefined && !SESSION_STATUS_VALUES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${SESSION_STATUS_VALUES.join(', ')}` })
    }
    if (attendance !== undefined && !SESSION_ATTENDANCE_VALUES.includes(attendance)) {
      return res.status(400).json({ error: `Invalid attendance. Allowed: ${SESSION_ATTENDANCE_VALUES.filter(Boolean).join(', ')} or none` })
    }

    const session = await ClassSession.findById(req.params.id)
    if (!session) return res.status(404).json({ error: 'Session not found' })

    const prevStatus = session.status
    const prevAttendance = session.attendance
    if (status !== undefined) session.status = status
    if (attendance !== undefined) session.attendance = attendance
    await session.save()

    emitToLiveBoard('live_board_changed', { action: 'status_edit', sessionId: session._id })

    await logActivity({
      level: 'warning',
      category: 'schedule',
      action: 'session_status_edit',
      message: `Session ${session._id} edited — status '${prevStatus}'→'${session.status}', attendance '${prevAttendance || 'none'}'→'${session.attendance || 'none'}'`,
      req,
      meta: {
        sessionId: session._id,
        previousStatus: prevStatus, previousAttendance: prevAttendance,
        status: session.status, attendance: session.attendance,
      },
    })

    res.json(session)
  } catch (err) {
    console.error('Update session status error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Live board: currently active sessions ───

// Karachi wall-clock now: { dateStr: 'YYYY-MM-DD', minutes: number-of-day }.
function karachiNow(base = new Date()) {
  const { dateStr } = tzDateInfo(base)
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false }).format(base)
  const [h, m] = hm.split(':').map(Number)
  return { dateStr, minutes: h * 60 + m }
}
const _toMin = (t) => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return h * 60 + m }

export async function getLiveBoard(req, res) {
  try {
    // This endpoint is gated by liveboard.view (oversight), so it always shows the
    // FULL board — including for oversight users who are themselves linked tutors
    // (e.g. a QCI who also teaches). Only a linked student (who should never reach
    // this permission) is ever scoped to their own row.
    const scope = {}
    if (req.user.linkedStudentId) scope.studentId = req.user.linkedStudentId

    const studentSel = 'name rollNo status performanceTags freshness leaveStartDate expectedResumeDate'

    // 1) Currently-live sessions (started) — green on the board.
    const activeSessions = await ClassSession.find({ status: 'started', ...scope })
      .populate('studentId', studentSel)
      .populate('tutorId', 'name tutorId roomNo meetLink')
      .populate('slotId', 'track durationMinutes')
      .sort({ tutorStartedAt: -1 })
      .lean()
    activeSessions.forEach(s => { s.boardState = 'live' })

    // 2) Due-now sessions still 'scheduled' (should be happening but the tutor
    //    hasn't started) — red on the board so oversight can nudge. Overnight
    //    aware: a night class dated yesterday whose after-midnight portion covers
    //    now still counts. Wall-clock comparison in Asia/Karachi.
    const { dateStr: today, minutes: nowMin } = karachiNow()
    const yesterday = addDaysStr(today, -1)
    const dayStart = new Date(`${yesterday}T00:00:00Z`)
    const dayEnd = new Date(`${today}T23:59:59.999Z`)
    const scheduled = await ClassSession.find({ status: 'scheduled', date: { $gte: dayStart, $lt: dayEnd }, ...scope })
      .populate('studentId', studentSel)
      .populate('tutorId', 'name tutorId roomNo meetLink')
      .populate('slotId', 'track durationMinutes')
      .lean()

    const due = scheduled.filter(s => {
      const st = _toMin(s.scheduledStart)
      const en = _toMin(s.scheduledEnd)
      if (st == null || en == null) return false
      const sDate = tzDateInfo(s.date).dateStr
      const crosses = en <= st
      if (sDate === today) {
        const endToday = crosses ? 1440 : en
        return nowMin >= st && nowMin < endToday
      }
      if (sDate === yesterday && crosses) {
        // after-midnight tail belongs to today
        return nowMin < en
      }
      return false
    })
    due.forEach(s => { s.boardState = 'due' })
    due.sort((a, b) => String(a.scheduledStart).localeCompare(String(b.scheduledStart)))

    // De-duplicate by class identity so a single class can NEVER show as both
    // live and due at the same time. If duplicate session documents exist for the
    // same class (slot + date + start), the 'started' (live) record wins over the
    // 'scheduled' (due) one.
    const classKey = (s) => {
      const slot = s.slotId?._id || s.slotId
      const stud = s.studentId?._id || s.studentId
      const tut = s.tutorId?._id || s.tutorId
      return `${slot || `${stud}:${tut}`}|${tzDateInfo(s.date).dateStr}|${s.scheduledStart}`
    }
    const byKey = new Map()
    for (const s of [...activeSessions, ...due]) {
      const key = classKey(s)
      const existing = byKey.get(key)
      if (!existing) { byKey.set(key, s); continue }
      // live wins over due
      if (existing.boardState === 'due' && s.boardState === 'live') byKey.set(key, s)
    }

    res.json([...byKey.values()])
  } catch (err) {
    console.error('Live board error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── A tutor's own live (started) sessions — no liveboard.view needed ───

export async function getMyLiveSessions(req, res) {
  try {
    if (!req.user.linkedTutorId) return res.json([])

    const sessions = await ClassSession.find({ status: 'started', tutorId: req.user.linkedTutorId })
      .populate('studentId', 'name rollNo status performanceTags freshness leaveStartDate expectedResumeDate')
      .populate('tutorId', 'name tutorId roomNo meetLink')
      .populate('slotId', 'track durationMinutes')
      .sort({ tutorStartedAt: -1 })
      .lean()

    res.json(sessions)
  } catch (err) {
    console.error('My live sessions error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Overdue / over-running class handling ───

// Planned length of a session in minutes: slot duration → start/end diff → 30 fallback.
function plannedMinutesOf(session) {
  const dur = session.slotId?.durationMinutes
  if (dur) return dur
  const st = _toMin(session.scheduledStart)
  const en = _toMin(session.scheduledEnd)
  if (st != null && en != null) {
    const diff = en > st ? en - st : 1440 - st + en // handle midnight cross
    if (diff > 0) return diff
  }
  return 30
}

// Notify the tutor of a session that they must log its lesson (after an auto/force
// complete that carried no lesson details).
async function notifyTutorToLog(session, { count = 1 } = {}) {
  const tutorU = await User.findOne({ linkedTutorId: session.tutorId, status: 'active' }).select('_id').lean()
  if (!tutorU) return
  await createNotification({
    userId: tutorU._id,
    type: 'lesson_log_required',
    title: count > 1 ? 'Log your lessons' : 'Log your lesson',
    body: count > 1
      ? `${count} of your classes were completed automatically after running over. Please log the lessons.`
      : `Your class was completed. Please add the lesson details when you get a chance.`,
    payload: { sessionId: session._id },
  })
}

// POST /sessions/:id/force-complete — oversight (liveboard.view) closes an overdue
// live class WITHOUT lesson details. Flags it so the tutor is prompted to log the
// lesson later. Idempotent for already-completed sessions.
export async function forceCompleteSession(req, res) {
  try {
    const session = await ClassSession.findById(req.params.id)
    if (!session) return res.status(404).json({ error: 'Session not found' })
    if (session.status === 'completed') return res.json(session)

    session.status = 'completed'
    session.autoEndedAt = new Date()
    session.needsLessonLog = true
    await session.save()

    emitToLiveBoard('live_board_changed', { action: 'force_completed', sessionId: session._id })
    await notifyTutorToLog(session)

    await logActivity({
      level: 'info', category: 'schedule', action: 'session_force_completed',
      message: `Session force-completed by oversight: ${session._id}`, req, meta: { sessionId: session._id },
    })

    res.json(session)
  } catch (err) {
    console.error('Force complete session error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /my-unlogged — a tutor's completed sessions still awaiting a lesson log
// (auto/force completed). Powers the "log your lesson" prompt.
export async function getMyUnloggedSessions(req, res) {
  try {
    if (!req.user.linkedTutorId) return res.json([])
    const sessions = await ClassSession.find({
      tutorId: req.user.linkedTutorId,
      status: 'completed',
      needsLessonLog: true,
      lessonEntryId: { $in: [null, undefined] },
    })
      .populate('studentId', 'name rollNo status performanceTags freshness leaveStartDate expectedResumeDate')
      .populate('tutorId', 'name tutorId roomNo meetLink')
      .populate('slotId', 'track durationMinutes')
      .sort({ date: -1, scheduledStart: -1 })
      .limit(50)
      .lean()
    res.json(sessions)
  } catch (err) {
    console.error('My unlogged sessions error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Background job: auto-complete any started class that has been live longer than
// AUTO_COMPLETE_AFTER_MIN. Notifies oversight (super_admin + qci) and prompts each
// tutor to log the lesson. Idempotent — completed sessions are excluded by the filter.
export async function autoCompleteOverrunSessions() {
  try {
    const cutoff = new Date(Date.now() - AUTO_COMPLETE_AFTER_MIN * 60000)
    // Use tutorStartedAt when present; otherwise fall back to updatedAt so legacy
    // stuck-live sessions (no start timestamp) are still closed out.
    const stuck = await ClassSession.find({
      status: 'started',
      $or: [
        { tutorStartedAt: { $lte: cutoff } },
        { tutorStartedAt: { $in: [null, undefined] }, updatedAt: { $lte: cutoff } },
      ],
    })
      .populate('slotId', 'durationMinutes')
      .lean()
    if (!stuck.length) return 0

    const ids = stuck.map(s => s._id)
    await ClassSession.updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'completed', autoEndedAt: new Date(), autoCompleted: true, needsLessonLog: true } },
    )

    // Notify oversight once for the batch.
    await notifyRoles(['super_admin', 'qci'], {
      type: 'class_auto_completed',
      title: 'Classes auto-completed',
      body: `${ids.length} class${ids.length > 1 ? 'es' : ''} ran over ${AUTO_COMPLETE_AFTER_MIN} min and ${ids.length > 1 ? 'were' : 'was'} auto-completed.`,
      payload: { count: ids.length },
    })

    // Prompt each affected tutor to log their lesson(s).
    const byTutor = new Map()
    for (const s of stuck) byTutor.set(String(s.tutorId), (byTutor.get(String(s.tutorId)) || 0) + 1)
    for (const [tutorId, count] of byTutor) {
      await notifyTutorToLog({ tutorId, _id: stuck.find(s => String(s.tutorId) === tutorId)._id }, { count })
    }

    emitToLiveBoard('live_board_changed', { action: 'auto_completed', count: ids.length })
    console.log(`[auto-complete] closed ${ids.length} over-running session(s)`)
    return ids.length
  } catch (err) {
    console.error('[auto-complete] error:', err.message)
    return 0
  }
}

// ─── Generate sessions from slots for a date ───

export async function generateSessionsForDate(req, res) {
  try {
    const { date } = req.body
    if (!date) return res.status(400).json({ error: 'date is required' })

    const created = await generateSessionsForDay(date)
    res.json({ message: created > 0 ? `Generated ${created} sessions` : 'No new sessions for this day', created })
  } catch (err) {
    console.error('Generate sessions error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Board view: tutors (columns) + a day's sessions in one scoped, unpaginated call ───
// Powers the tutor × time-block board. Returns every active tutor (so empty lanes are
// visible for slot creation), each tutor's recurring-slot count for the weekday, and all
// sessions on the date. Day-bounded so volume stays safe without pagination.
export async function getBoard(req, res) {
  try {
    const dateStr = (req.query.date || tzDateInfo().dateStr).slice(0, 10)
    const dow = dayOfWeekOf(dateStr)
    const dateStart = new Date(dateStr); dateStart.setHours(0, 0, 0, 0)
    const dateEnd = new Date(dateStr); dateEnd.setHours(23, 59, 59, 999)

    const { tutorId, studentId, status, track } = req.query

    // Night-shift support: when the board window wraps past midnight
    // (startHour > endHour, e.g. 20:00 → 07:00), also pull the *next* calendar
    // day's early-morning sessions so the continuous night grid is complete.
    const startHour = req.query.startHour != null ? parseInt(req.query.startHour, 10) : null
    const endHour = req.query.endHour != null ? parseInt(req.query.endHour, 10) : null
    const wraps = startHour != null && endHour != null && startHour > endHour

    // Sessions — same scoping rules as listSessions. Oversight (schedule.manage)
    // sees the whole board; a plain linked tutor sees only their own lane.
    const seesAll = req.userPermissions?.has('schedule.manage')
    const baseScope = {}
    if (req.user.linkedStudentId) {
      baseScope.studentId = req.user.linkedStudentId
    } else if (req.user.linkedTutorId && !seesAll) {
      baseScope.tutorId = req.user.linkedTutorId
      if (studentId) baseScope.studentId = studentId
    } else {
      if (tutorId) baseScope.tutorId = tutorId
      if (studentId) baseScope.studentId = studentId
    }
    if (status) baseScope.status = status

    const sFilter = { date: { $gte: dateStart, $lt: dateEnd }, ...baseScope }

    const studentSel = 'name rollNo status performanceTags freshness leaveStartDate expectedResumeDate'
    let sessions = await ClassSession.find(sFilter)
      .populate('studentId', studentSel)
      .populate('tutorId', 'name tutorId')
      .populate('slotId', 'track tracks meetLink durationMinutes startTime dayOfWeek active')
      .populate({ path: 'lessonEntryId', select: 'kind items customText notes classStart classEnd', populate: { path: 'items.curriculumItemId', select: 'label track type' } })
      .sort({ scheduledStart: 1 })
      .lean()
    sessions.forEach(s => { s.dayOffset = 0 })

    // Pull next-day early-morning sessions (before endHour) for the wrap window
    if (wraps) {
      const nextStart = new Date(dateStr); nextStart.setDate(nextStart.getDate() + 1); nextStart.setHours(0, 0, 0, 0)
      const nextEnd = new Date(nextStart); nextEnd.setHours(23, 59, 59, 999)
      const cutoff = String(endHour).padStart(2, '0') + ':00'
      let nextSessions = await ClassSession.find({ date: { $gte: nextStart, $lt: nextEnd }, ...baseScope })
        .populate('studentId', studentSel)
        .populate('tutorId', 'name tutorId')
        .populate('slotId', 'track tracks meetLink durationMinutes startTime dayOfWeek active')
        .populate({ path: 'lessonEntryId', select: 'kind items customText notes classStart classEnd', populate: { path: 'items.curriculumItemId', select: 'label track type' } })
        .sort({ scheduledStart: 1 })
        .lean()
      // Only starts strictly before endHour:00 fall inside the visible night grid.
      nextSessions = nextSessions.filter(s => s.scheduledStart && s.scheduledStart < cutoff)
      nextSessions.forEach(s => { s.dayOffset = 1 })
      sessions = sessions.concat(nextSessions)
    }

    // Track lives on the slot, not the session — filter in memory after populate
    if (track) {
      sessions = sessions.filter(s => {
        const t = s.slotId?.tracks?.length ? s.slotId.tracks : (s.slotId?.track ? [s.slotId.track] : [])
        return t.includes(track)
      })
    }

    // Tutors — columns of the board
    const tFilter = { status: 'active' }
    if (req.user.linkedTutorId && !seesAll) tFilter._id = req.user.linkedTutorId
    else if (tutorId) tFilter._id = tutorId
    const tutors = await TutorProfile.find(tFilter).select('name tutorId status').sort({ name: 1 }).lean()

    // Recurring-slot count per tutor for this weekday
    const slotAgg = await ClassSlot.aggregate([
      { $match: { dayOfWeek: dow, active: true } },
      { $group: { _id: '$tutorId', count: { $sum: 1 } } },
    ])
    const slotCounts = {}
    slotAgg.forEach(s => { slotCounts[String(s._id)] = s.count })
    tutors.forEach(t => { t.slotCount = slotCounts[String(t._id)] || 0 })

    res.json({ date: dateStr, dayOfWeek: dow, tutors, sessions })
  } catch (err) {
    console.error('Get board error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Patch a session — reschedule (date/time), reassign tutor/student, set status, edit notes.
export async function updateSession(req, res) {
  try {
    const session = await ClassSession.findById(req.params.id)
    if (!session) return res.status(404).json({ error: 'Session not found' })

    const fields = ['tutorId', 'studentId', 'scheduledStart', 'scheduledEnd', 'status', 'notes']
    for (const f of fields) {
      if (req.body[f] !== undefined) session[f] = req.body[f]
    }
    if (req.body.date !== undefined) session.date = new Date(req.body.date)

    await session.save()

    await logActivity({
      level: 'info', category: 'schedule', action: 'session_updated',
      message: `Session updated: ${session._id}`, req, meta: { sessionId: session._id },
    })

    const populated = await ClassSession.findById(session._id)
      .populate('studentId', 'name rollNo status performanceTags freshness leaveStartDate expectedResumeDate')
      .populate('tutorId', 'name tutorId')
      .populate('slotId', 'track tracks meetLink durationMinutes startTime dayOfWeek active')
      .lean()
    res.json(populated)
  } catch (err) {
    console.error('Update session error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Hard-delete a single session (does not touch the recurring slot).
export async function deleteSession(req, res) {
  try {
    const session = await ClassSession.findById(req.params.id)
    if (!session) return res.status(404).json({ error: 'Session not found' })

    await ClassSession.findByIdAndDelete(req.params.id)

    await logActivity({
      level: 'warning', category: 'schedule', action: 'session_deleted',
      message: `Session deleted: ${session._id}`, req, meta: { sessionId: session._id },
    })

    res.json({ message: 'Session deleted' })
  } catch (err) {
    console.error('Delete session error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Schedule config (auto-generation toggle) ───
export async function getScheduleConfig(req, res) {
  try {
    let cfg = await ScheduleConfig.findOne({ key: 'default' }).lean()
    if (!cfg) cfg = (await ScheduleConfig.create({ key: 'default' })).toObject()
    res.json({ autoGenerateSessions: cfg.autoGenerateSessions !== false, skillCapacity: resolveSkillCapacity(cfg) })
  } catch (err) {
    console.error('Get schedule config error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateScheduleConfig(req, res) {
  try {
    const update = {}
    if (req.body.autoGenerateSessions !== undefined) update.autoGenerateSessions = !!req.body.autoGenerateSessions
    if (req.body.skillCapacity && typeof req.body.skillCapacity === 'object') {
      for (const key of ['beginner', 'medium', 'professional', 'expert']) {
        if (req.body.skillCapacity[key] !== undefined) {
          update[`skillCapacity.${key}`] = Math.max(0, parseInt(req.body.skillCapacity[key], 10) || 0)
        }
      }
    }
    const cfg = await ScheduleConfig.findOneAndUpdate(
      { key: 'default' }, { $set: update }, { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean()
    // If just enabled, immediately generate today's sessions.
    if (update.autoGenerateSessions === true) {
      const { dateStr } = tzDateInfo()
      await generateSessionsForDay(dateStr)
    }
    await logActivity({ level: 'info', category: 'schedule', action: 'schedule_config_updated', message: `Auto-generate sessions: ${cfg.autoGenerateSessions}`, req })
    res.json({ autoGenerateSessions: cfg.autoGenerateSessions !== false, skillCapacity: resolveSkillCapacity(cfg) })
  } catch (err) {
    console.error('Update schedule config error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

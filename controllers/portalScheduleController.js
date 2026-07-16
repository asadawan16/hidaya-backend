import ClassSlot from '../models/ClassSlot.js'
import ClassSession from '../models/ClassSession.js'
import ScheduleConfig from '../models/ScheduleConfig.js'
import Student from '../models/Student.js'
import TutorProfile from '../models/TutorProfile.js'
import User from '../models/User.js'
import { logActivity } from '../utils/activityLogger.js'
import { createNotification } from './portalNotificationController.js'
import { emitToLiveBoard } from '../config/socket.js'

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

// Create any missing sessions for the given date from active slots on that weekday.
// Idempotent (dedupes by slotId + date). Returns the number created.
export async function generateSessionsForDay(dateStr) {
  const dayOfWeek = dayOfWeekOf(dateStr)
  const slots = await ClassSlot.find({ dayOfWeek, active: true }).lean()
  if (slots.length === 0) return 0

  const dateStart = new Date(dateStr); dateStart.setHours(0, 0, 0, 0)
  const dateEnd = new Date(dateStr); dateEnd.setHours(23, 59, 59, 999)
  const existing = await ClassSession.find({
    slotId: { $in: slots.map(s => s._id) },
    date: { $gte: dateStart, $lt: dateEnd },
  }).select('slotId').lean()
  const existingSlotIds = new Set(existing.map(s => s.slotId.toString()))

  const toCreate = []
  for (const slot of slots) {
    if (existingSlotIds.has(slot._id.toString())) continue
    const [h, m] = slot.startTime.split(':').map(Number)
    const endMinutes = h * 60 + m + slot.durationMinutes
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`
    toCreate.push({
      slotId: slot._id,
      studentId: slot.studentId,
      tutorId: slot.tutorId,
      date: new Date(dateStr),
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
    const { dateStr } = tzDateInfo()
    const created = await generateSessionsForDay(dateStr)
    if (created > 0) console.log(`[auto-sessions] generated ${created} session(s) for ${dateStr}`)
  } catch (err) {
    console.error('[auto-sessions] error:', err.message)
  }
}

// ─── ClassSlot CRUD ───

export async function listSlots(req, res) {
  try {
    const { tutorId, studentId, dayOfWeek, active } = req.query
    const filter = {}
    // Scope: students see only their own, tutors see only their students
    if (req.user.linkedStudentId) {
      filter.studentId = req.user.linkedStudentId
    } else if (req.user.linkedTutorId) {
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

    // Legacy callers (no ?page) get a flat array; paginated callers get an envelope
    if (!req.query.page) {
      const records = await query().limit(500).lean()
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

    const createdSlots = []
    const today = new Date()
    const todayStart = new Date(today); todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date(today); todayEnd.setHours(23, 59, 59, 999)
    const todayDow = today.getDay()

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

      // Auto-create session for today if matching
      if (todayDow === dow) {
        const existing = await ClassSession.findOne({ slotId: slot._id, date: { $gte: todayStart, $lt: todayEnd } })
        if (!existing) {
          const [h, m] = startTime.split(':').map(Number)
          const endMins = h * 60 + m + (durationMinutes || 30)
          const endTime = `${String(Math.floor(endMins / 60) % 24).padStart(2, '0')}:${String(endMins % 60).padStart(2, '0')}`
          await ClassSession.create({
            slotId: slot._id,
            studentId, tutorId,
            date: todayStart,
            scheduledStart: startTime,
            scheduledEnd: endTime,
            status: 'scheduled',
          })
        }
      }

      const populated = await ClassSlot.findById(slot._id)
        .populate('studentId', 'name rollNo status performanceTags freshness leaveStartDate expectedResumeDate')
        .populate('tutorId', 'name tutorId')
        .lean()

      createdSlots.push(populated)
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

// ─── ClassSession ───

export async function listSessions(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30))
    const { tutorId, studentId, date, dateFrom, dateTo, status, sort } = req.query

    const filter = {}
    // Scope: students see only their own, tutors see only their students
    if (req.user.linkedStudentId) {
      filter.studentId = req.user.linkedStudentId
    } else if (req.user.linkedTutorId) {
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

    const total = await ClassSession.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    let sortObj = { date: -1, scheduledStart: -1 }
    if (sort === 'date') sortObj = { date: 1, scheduledStart: 1 }
    if (sort === 'status') sortObj = { status: 1, date: -1 }

    const records = await ClassSession.find(filter)
      .populate('studentId', 'name rollNo status performanceTags freshness leaveStartDate expectedResumeDate')
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

// ─── Live board: currently active sessions ───

export async function getLiveBoard(req, res) {
  try {
    const filter = { status: 'started' }
    // Scope: students see only their own, tutors see only their students
    if (req.user.linkedStudentId) {
      filter.studentId = req.user.linkedStudentId
    } else if (req.user.linkedTutorId) {
      filter.tutorId = req.user.linkedTutorId
    }

    const activeSessions = await ClassSession.find(filter)
      .populate('studentId', 'name rollNo status performanceTags freshness leaveStartDate expectedResumeDate')
      .populate('tutorId', 'name tutorId roomNo meetLink')
      .populate('slotId', 'track durationMinutes')
      .sort({ tutorStartedAt: -1 })
      .lean()

    res.json(activeSessions)
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

    const { tutorId, status, track } = req.query

    // Night-shift support: when the board window wraps past midnight
    // (startHour > endHour, e.g. 20:00 → 07:00), also pull the *next* calendar
    // day's early-morning sessions so the continuous night grid is complete.
    const startHour = req.query.startHour != null ? parseInt(req.query.startHour, 10) : null
    const endHour = req.query.endHour != null ? parseInt(req.query.endHour, 10) : null
    const wraps = startHour != null && endHour != null && startHour > endHour

    // Sessions — same scoping rules as listSessions
    const baseScope = {}
    if (req.user.linkedStudentId) baseScope.studentId = req.user.linkedStudentId
    else if (req.user.linkedTutorId) baseScope.tutorId = req.user.linkedTutorId
    else if (tutorId) baseScope.tutorId = tutorId
    if (status) baseScope.status = status

    const sFilter = { date: { $gte: dateStart, $lt: dateEnd }, ...baseScope }

    const studentSel = 'name rollNo status performanceTags freshness leaveStartDate expectedResumeDate'
    let sessions = await ClassSession.find(sFilter)
      .populate('studentId', studentSel)
      .populate('tutorId', 'name tutorId')
      .populate('slotId', 'track tracks meetLink durationMinutes startTime dayOfWeek active')
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
    if (req.user.linkedTutorId) tFilter._id = req.user.linkedTutorId
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
    res.json({ autoGenerateSessions: cfg.autoGenerateSessions !== false })
  } catch (err) {
    console.error('Get schedule config error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateScheduleConfig(req, res) {
  try {
    const update = {}
    if (req.body.autoGenerateSessions !== undefined) update.autoGenerateSessions = !!req.body.autoGenerateSessions
    const cfg = await ScheduleConfig.findOneAndUpdate(
      { key: 'default' }, { $set: update }, { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean()
    // If just enabled, immediately generate today's sessions.
    if (update.autoGenerateSessions === true) {
      const { dateStr } = tzDateInfo()
      await generateSessionsForDay(dateStr)
    }
    await logActivity({ level: 'info', category: 'schedule', action: 'schedule_config_updated', message: `Auto-generate sessions: ${cfg.autoGenerateSessions}`, req })
    res.json({ autoGenerateSessions: cfg.autoGenerateSessions !== false })
  } catch (err) {
    console.error('Update schedule config error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

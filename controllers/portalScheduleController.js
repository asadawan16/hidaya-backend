import ClassSlot from '../models/ClassSlot.js'
import ClassSession from '../models/ClassSession.js'
import { logActivity } from '../utils/activityLogger.js'

// ─── ClassSlot CRUD ───

export async function listSlots(req, res) {
  try {
    const { tutorId, studentId, dayOfWeek, active } = req.query
    const filter = {}
    if (tutorId) filter.tutorId = tutorId
    if (studentId) filter.studentId = studentId
    if (dayOfWeek !== undefined) filter.dayOfWeek = Number(dayOfWeek)
    if (active !== undefined) filter.active = active === 'true'

    const records = await ClassSlot.find(filter)
      .populate('studentId', 'name rollNo')
      .populate('tutorId', 'name tutorId meetLink')
      .sort({ dayOfWeek: 1, startTime: 1 })
      .limit(200)
      .lean()

    res.json(records)
  } catch (err) {
    console.error('List slots error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createSlot(req, res) {
  try {
    const { studentId, tutorId, track, dayOfWeek, startTime, durationMinutes, timezone, meetLink } = req.body
    if (!studentId || !tutorId || dayOfWeek === undefined || !startTime) {
      return res.status(400).json({ error: 'studentId, tutorId, dayOfWeek, and startTime are required' })
    }

    const slot = await ClassSlot.create({
      studentId, tutorId,
      track: track || 'nazra',
      dayOfWeek,
      startTime,
      durationMinutes: durationMinutes || 30,
      timezone: timezone || 'Asia/Karachi',
      meetLink: meetLink || '',
      active: true,
    })

    await logActivity({
      level: 'info',
      category: 'schedule',
      action: 'slot_created',
      message: `Class slot created: day ${dayOfWeek} at ${startTime}`,
      req,
      meta: { slotId: slot._id },
    })

    const populated = await ClassSlot.findById(slot._id)
      .populate('studentId', 'name rollNo')
      .populate('tutorId', 'name tutorId')
      .lean()

    res.status(201).json(populated)
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
    const { tutorId, studentId, date, dateFrom, dateTo, status } = req.query

    const filter = {}
    if (tutorId) filter.tutorId = tutorId
    if (studentId) filter.studentId = studentId
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

    const records = await ClassSession.find(filter)
      .populate('studentId', 'name rollNo')
      .populate('tutorId', 'name tutorId')
      .populate('slotId', 'track meetLink')
      .sort({ date: -1, scheduledStart: -1 })
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

    const { attendance, actualStudentJoinTime, notes } = req.body

    session.status = 'completed'
    session.autoEndedAt = new Date()
    if (attendance) session.attendance = attendance
    if (notes) session.notes = notes

    if (actualStudentJoinTime) {
      session.actualStudentJoinTime = new Date(actualStudentJoinTime)
      // Compute duration = scheduledEnd - actualJoinTime
      const endParts = session.scheduledEnd.split(':').map(Number)
      const joinTime = new Date(actualStudentJoinTime)
      const endMinutes = endParts[0] * 60 + endParts[1]
      const joinMinutes = joinTime.getHours() * 60 + joinTime.getMinutes()
      session.computedDuration = Math.max(0, endMinutes - joinMinutes)
    }

    await session.save()

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

    res.json(session)
  } catch (err) {
    console.error('Mark missed error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Live board: currently active sessions ───

export async function getLiveBoard(req, res) {
  try {
    const activeSessions = await ClassSession.find({ status: 'started' })
      .populate('studentId', 'name rollNo')
      .populate('tutorId', 'name tutorId roomNo meetLink')
      .populate('slotId', 'track')
      .sort({ tutorStartedAt: -1 })
      .lean()

    res.json(activeSessions)
  } catch (err) {
    console.error('Live board error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Generate sessions from slots for a date ───

export async function generateSessionsForDate(req, res) {
  try {
    const { date } = req.body
    if (!date) return res.status(400).json({ error: 'date is required' })

    const d = new Date(date)
    const dayOfWeek = d.getDay()

    const slots = await ClassSlot.find({ dayOfWeek, active: true }).lean()
    if (slots.length === 0) return res.json({ message: 'No slots for this day', created: 0 })

    // Batch check existing sessions for this date (avoids N+1)
    const dateStart = new Date(date); dateStart.setHours(0, 0, 0, 0)
    const dateEnd = new Date(date); dateEnd.setHours(23, 59, 59, 999)
    const existingSessions = await ClassSession.find({
      slotId: { $in: slots.map(s => s._id) },
      date: { $gte: dateStart, $lt: dateEnd },
    }).select('slotId').lean()
    const existingSlotIds = new Set(existingSessions.map(s => s.slotId.toString()))

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
        date: new Date(date),
        scheduledStart: slot.startTime,
        scheduledEnd: endTime,
        status: 'scheduled',
      })
    }

    if (toCreate.length > 0) await ClassSession.insertMany(toCreate)

    res.json({ message: `Generated ${toCreate.length} sessions`, created: toCreate.length })
  } catch (err) {
    console.error('Generate sessions error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

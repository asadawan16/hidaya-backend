import TutorAttendance from '../models/TutorAttendance.js'
import { logActivity } from '../utils/activityLogger.js'

// ── Subject helpers ──────────────────────────────────────────────────────────
// An attendance record belongs to a tutor (tutorId) or a management/staff user
// (userId). These helpers resolve the subject from a request or the caller.

function subjectFromSrc(src = {}) {
  if (src.userId) return { subjectType: 'staff', userId: src.userId }
  if (src.tutorId) return { subjectType: 'tutor', tutorId: src.tutorId }
  return null
}

// The caller's own subject — tutors have a linked profile; everyone else (staff /
// management) is scoped by their own userId.
function selfSubject(req) {
  if (req.user.linkedTutorId) return { subjectType: 'tutor', tutorId: req.user.linkedTutorId }
  return { subjectType: 'staff', userId: req.userId }
}

// Mongo filter for a subject (the id field only).
function subjectFilter(subject) {
  return subject.subjectType === 'staff' ? { userId: subject.userId } : { tutorId: subject.tutorId }
}

const subjectLabel = (subject) => (subject.subjectType === 'staff' ? `Staff ${subject.userId}` : `Tutor ${subject.tutorId}`)

// The caller's own attendance record for today. Self-scoped (no permission).
export async function getMyTodayAttendance(req, res) {
  try {
    const subject = selfSubject(req)
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const record = await TutorAttendance.findOne({ ...subjectFilter(subject), date: today }).lean()
    res.json(record || null)
  } catch (err) {
    console.error('My today attendance error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function listAttendance(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30))
    const { tutorId, userId, subjectType, dateFrom, dateTo, status, sort } = req.query

    const filter = {}
    if (tutorId) filter.tutorId = tutorId
    if (userId) filter.userId = userId
    if (subjectType) filter.subjectType = subjectType
    if (status) filter.status = status
    if (dateFrom || dateTo) {
      filter.date = {}
      if (dateFrom) filter.date.$gte = new Date(dateFrom)
      if (dateTo) filter.date.$lte = new Date(dateTo)
    }

    const total = await TutorAttendance.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await TutorAttendance.find(filter)
      .populate('tutorId', 'name tutorId')
      .populate('userId', 'displayName email')
      .sort(sort === 'date' ? { date: 1 } : { date: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List attendance error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function checkIn(req, res) {
  try {
    // Explicit subject (admin checking someone in) or the caller's own.
    const subject = subjectFromSrc(req.body) || selfSubject(req)

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const filter = { ...subjectFilter(subject), date: today }

    let record = await TutorAttendance.findOne(filter)
    if (record && record.checkInAt) {
      return res.status(400).json({ error: 'Already checked in today' })
    }

    if (!record) {
      record = await TutorAttendance.create({
        ...filter,
        subjectType: subject.subjectType,
        checkInAt: new Date(),
        status: 'present',
      })
    } else {
      record.checkInAt = new Date()
      record.status = 'present'
      await record.save()
    }

    await logActivity({
      level: 'info', category: 'attendance', action: 'checkin',
      message: `${subjectLabel(subject)} checked in`, req,
      meta: { ...subjectFilter(subject), attendanceId: record._id },
    })

    res.json(record)
  } catch (err) {
    console.error('Check in error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function checkOut(req, res) {
  try {
    const subject = subjectFromSrc(req.body) || selfSubject(req)

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const record = await TutorAttendance.findOne({ ...subjectFilter(subject), date: today })
    if (!record || !record.checkInAt) {
      return res.status(400).json({ error: 'Not checked in today' })
    }
    if (record.checkOutAt) {
      return res.status(400).json({ error: 'Already checked out today' })
    }

    record.checkOutAt = new Date()
    const diffMs = record.checkOutAt - record.checkInAt
    record.totalHours = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100
    if (req.body.isOvertime) record.isOvertime = true
    if (req.body.overtimeReason) record.overtimeReason = req.body.overtimeReason
    await record.save()

    await logActivity({
      level: 'info', category: 'attendance', action: 'checkout',
      message: `${subjectLabel(subject)} checked out (${record.totalHours}h)`, req,
      meta: { ...subjectFilter(subject), attendanceId: record._id },
    })

    res.json(record)
  } catch (err) {
    console.error('Check out error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function markAbsent(req, res) {
  try {
    const subject = subjectFromSrc(req.body)
    const { date, notes } = req.body
    if (!subject || !date) return res.status(400).json({ error: 'tutorId or userId, and date are required' })

    const d = new Date(date)
    d.setHours(0, 0, 0, 0)
    const filter = { ...subjectFilter(subject), date: d }

    let record = await TutorAttendance.findOne(filter)
    if (record && record.status === 'present') {
      return res.status(400).json({ error: 'Already marked present for this date' })
    }

    if (!record) {
      record = await TutorAttendance.create({
        ...filter, subjectType: subject.subjectType, status: 'absent',
        notes: notes || 'Marked absent by admin',
      })
    } else {
      record.status = 'absent'
      record.notes = notes || 'Marked absent by admin'
      await record.save()
    }

    await logActivity({
      level: 'info', category: 'attendance', action: 'marked_absent',
      message: `${subjectLabel(subject)} marked absent for ${d.toDateString()}`, req,
      meta: { ...subjectFilter(subject), date: d },
    })

    res.json(record)
  } catch (err) {
    console.error('Mark absent error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getAttendanceSummary(req, res) {
  try {
    const subject = subjectFromSrc(req.query)
    const { month, year } = req.query
    if (!subject || !month || !year) {
      return res.status(400).json({ error: 'tutorId or userId, month, and year are required' })
    }

    const startDate = new Date(year, month - 1, 1)
    const endDate = new Date(year, month, 0, 23, 59, 59)

    const records = await TutorAttendance.find({
      ...subjectFilter(subject),
      date: { $gte: startDate, $lte: endDate },
    }).sort({ date: 1 }).lean()

    const presentDays = records.filter(r => r.status === 'present').length
    const absentDays = records.filter(r => r.status === 'absent').length
    const totalHours = records.reduce((sum, r) => sum + (r.totalHours || 0), 0)

    res.json({ records, presentDays, absentDays, totalHours, totalDays: records.length })
  } catch (err) {
    console.error('Attendance summary error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

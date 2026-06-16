import TutorAttendance from '../models/TutorAttendance.js'
import { logActivity } from '../utils/activityLogger.js'

export async function listAttendance(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30))
    const { tutorId, dateFrom, dateTo, status } = req.query

    const filter = {}
    if (tutorId) filter.tutorId = tutorId
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
      .sort({ date: -1 })
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
    const { tutorId } = req.body
    if (!tutorId) return res.status(400).json({ error: 'tutorId is required' })

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    let record = await TutorAttendance.findOne({ tutorId, date: today })
    if (record && record.checkInAt) {
      return res.status(400).json({ error: 'Already checked in today' })
    }

    if (!record) {
      record = await TutorAttendance.create({
        tutorId,
        date: today,
        checkInAt: new Date(),
        status: 'present',
      })
    } else {
      record.checkInAt = new Date()
      record.status = 'present'
      await record.save()
    }

    await logActivity({
      level: 'info',
      category: 'attendance',
      action: 'tutor_checkin',
      message: `Tutor ${tutorId} checked in`,
      req,
      meta: { tutorId, attendanceId: record._id },
    })

    res.json(record)
  } catch (err) {
    console.error('Check in error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function checkOut(req, res) {
  try {
    const { tutorId } = req.body
    if (!tutorId) return res.status(400).json({ error: 'tutorId is required' })

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const record = await TutorAttendance.findOne({ tutorId, date: today })
    if (!record || !record.checkInAt) {
      return res.status(400).json({ error: 'Not checked in today' })
    }
    if (record.checkOutAt) {
      return res.status(400).json({ error: 'Already checked out today' })
    }

    record.checkOutAt = new Date()
    const diffMs = record.checkOutAt - record.checkInAt
    record.totalHours = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100
    await record.save()

    await logActivity({
      level: 'info',
      category: 'attendance',
      action: 'tutor_checkout',
      message: `Tutor ${tutorId} checked out (${record.totalHours}h)`,
      req,
      meta: { tutorId, attendanceId: record._id },
    })

    res.json(record)
  } catch (err) {
    console.error('Check out error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getAttendanceSummary(req, res) {
  try {
    const { tutorId, month, year } = req.query
    if (!tutorId || !month || !year) {
      return res.status(400).json({ error: 'tutorId, month, and year are required' })
    }

    const startDate = new Date(year, month - 1, 1)
    const endDate = new Date(year, month, 0, 23, 59, 59)

    const records = await TutorAttendance.find({
      tutorId,
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

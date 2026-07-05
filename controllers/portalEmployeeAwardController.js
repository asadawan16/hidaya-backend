import EmployeeOfMonth from '../models/EmployeeOfMonth.js'
import Notification from '../models/Notification.js'
import User from '../models/User.js'
import { logActivity } from '../utils/activityLogger.js'
import { getIO, emitToUser } from '../config/socket.js'

export async function listAwards(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20))

    const total = await EmployeeOfMonth.countDocuments()
    const pages = Math.ceil(total / lim) || 1

    const records = await EmployeeOfMonth.find()
      .populate('tutorId', 'name tutorId')
      .populate('awardedBy', 'displayName')
      .sort({ year: -1, month: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: pg, pages })
  } catch (err) {
    console.error('List awards error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getCurrentAward(req, res) {
  try {
    const now = new Date()
    const award = await EmployeeOfMonth.findOne({
      year: now.getFullYear(),
      month: now.getMonth() + 1,
    })
      .populate('tutorId', 'name tutorId')
      .populate('awardedBy', 'displayName')
      .lean()

    res.json(award || null)
  } catch (err) {
    console.error('Get current award error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createAward(req, res) {
  try {
    const { tutorId, month, year, reason } = req.body
    if (!tutorId || !month || !year) {
      return res.status(400).json({ error: 'tutorId, month, and year are required' })
    }

    const existing = await EmployeeOfMonth.findOne({ year, month })
    if (existing) {
      return res.status(400).json({ error: 'An employee of the month has already been selected for this period' })
    }

    const award = await EmployeeOfMonth.create({
      tutorId, month, year,
      reason: reason || '',
      awardedBy: req.userId,
    })

    const populated = await EmployeeOfMonth.findById(award._id)
      .populate('tutorId', 'name tutorId')
      .populate('awardedBy', 'displayName')
      .lean()

    // Notify all tutors via socket and create notifications
    const tutorUsers = await User.find({ status: 'active', roles: { $exists: true } })
      .populate('roles', 'key')
      .lean()

    const tutorUserIds = tutorUsers
      .filter(u => u.roles?.some(r => r.key === 'tutor'))
      .map(u => u._id)

    const notifications = tutorUserIds.map(userId => ({
      userId,
      type: 'employee_of_month',
      title: 'Employee of the Month',
      body: `${populated.tutorId?.name} has been awarded Employee of the Month!`,
      payload: { awardId: award._id, tutorName: populated.tutorId?.name },
    }))

    try {
      if (notifications.length > 0) {
        const created = await Notification.insertMany(notifications)
        // Live bell update — the client's SocketContext listens for 'notification'
        created.forEach(n => emitToUser(n.userId, 'notification', n))
      }
    } catch (e) { console.error('notify failed:', e.message) }

    // Socket emit
    try {
      const io = getIO()
      if (io) {
        const portalNsp = io.of('/portal')
        portalNsp.to('role:tutor').emit('employee_of_month', {
          tutorName: populated.tutorId?.name,
          month, year, reason,
        })
      }
    } catch {}

    await logActivity({
      level: 'info', category: 'award', action: 'employee_of_month_awarded',
      message: `Employee of the Month: ${populated.tutorId?.name} (${month}/${year})`,
      req,
    })

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create award error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function acknowledgeAward(req, res) {
  try {
    const award = await EmployeeOfMonth.findById(req.params.id)
    if (!award) return res.status(404).json({ error: 'Award not found' })

    award.acknowledgedAt = new Date()
    await award.save()

    res.json(award)
  } catch (err) {
    console.error('Acknowledge award error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getUnacknowledgedAward(req, res) {
  try {
    const tutorId = req.user?.linkedTutorId
    if (!tutorId) return res.json(null)

    const award = await EmployeeOfMonth.findOne({
      tutorId,
      acknowledgedAt: null,
    })
      .populate('tutorId', 'name tutorId')
      .populate('awardedBy', 'displayName')
      .lean()

    res.json(award || null)
  } catch (err) {
    console.error('Get unacknowledged award error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

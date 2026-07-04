import Badge from '../models/Badge.js'
import Notification from '../models/Notification.js'
import User from '../models/User.js'
import { logActivity } from '../utils/activityLogger.js'
import { emitToUser, emitToRole } from '../config/socket.js'
import { createNotification } from './portalNotificationController.js'

export async function listBadges(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30))
    const { studentId, status, badgeType } = req.query

    const filter = {}
    // Students see only their own approved badges
    if (req.user.linkedStudentId) {
      filter.studentId = req.user.linkedStudentId
      filter.status = 'approved'
    } else {
      if (studentId) filter.studentId = studentId
      if (status) filter.status = status
    }
    if (badgeType) filter.badgeType = badgeType

    const total = await Badge.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await Badge.find(filter)
      .populate('studentId', 'name rollNo')
      .populate('submittedBy', 'displayName')
      .populate('approvedBy', 'displayName')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List badges error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createBadge(req, res) {
  try {
    const { studentId, badgeType, title, description } = req.body
    if (!studentId || !badgeType || !title) {
      return res.status(400).json({ error: 'studentId, badgeType, and title are required' })
    }

    // Auto-approve if user has badge.approve permission
    const canApprove = req.userPermissions?.has('badge.approve')
    const badge = await Badge.create({
      studentId, badgeType, title,
      description: description || '',
      status: canApprove ? 'approved' : 'pending',
      submittedBy: req.userId,
      ...(canApprove ? { approvedBy: req.userId, approvedAt: new Date() } : {}),
    })

    const populated = await Badge.findById(badge._id)
      .populate('studentId', 'name rollNo')
      .populate('submittedBy', 'displayName')
      .lean()

    const studentName = populated.studentId?.name || 'Student'

    if (canApprove) {
      // Notify student directly
      const studentUser = await User.findOne({ linkedStudentId: studentId, status: 'active' })
      if (studentUser) {
        await createNotification({
          userId: studentUser._id,
          type: 'badge_awarded',
          title: 'Badge Awarded!',
          body: `You have been awarded the "${title}" badge!`,
          payload: { badgeId: badge._id, badgeType, title },
        })
        emitToUser(studentUser._id, 'badge_awarded', { badgeId: badge._id, badgeType, title })
      }
    } else {
      // Notify approvers (admin, qci, qcm, principal)
      const allUsers = await User.find({ status: 'active' }).populate('roles', 'key').lean()
      const approverRoles = ['super_admin', 'admin', 'qci', 'qcm', 'principal']
      const approvers = allUsers.filter(u =>
        u.roles?.some(r => approverRoles.includes(r.key)) && u._id.toString() !== req.userId.toString()
      )
      try {
        if (approvers.length > 0) {
        await Notification.insertMany(approvers.map(u => ({
          userId: u._id,
          type: 'badge_awarded',
          title: 'Badge Pending Approval',
          body: `A "${title}" badge for ${studentName} needs your approval.`,
          payload: { badgeId: badge._id, badgeType, studentName },
        })))
        }
      } catch (e) { console.error('notify failed:', e.message) }
      for (const role of approverRoles) {
        emitToRole(role, 'badge_pending', { badgeId: badge._id, title, studentName })
      }
    }

    await logActivity({
      level: 'info', category: 'badge', action: canApprove ? 'badge_awarded' : 'badge_submitted',
      message: `Badge "${title}" ${canApprove ? 'awarded to' : 'submitted for'} ${studentName}`,
      req,
    })

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create badge error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function approveBadge(req, res) {
  try {
    const badge = await Badge.findById(req.params.id)
    if (!badge) return res.status(404).json({ error: 'Badge not found' })
    if (badge.status !== 'pending') return res.status(400).json({ error: 'Badge already reviewed' })

    badge.status = 'approved'
    badge.approvedBy = req.userId
    badge.approvedAt = new Date()
    badge.rejectionReason = ''
    await badge.save()

    const populated = await Badge.findById(badge._id)
      .populate('studentId', 'name rollNo')
      .populate('approvedBy', 'displayName')
      .lean()

    // Notify student
    const studentUser = await User.findOne({ linkedStudentId: badge.studentId, status: 'active' })
    if (studentUser) {
      await createNotification({
        userId: studentUser._id,
        type: 'badge_awarded',
        title: 'Badge Awarded!',
        body: `You have been awarded the "${badge.title}" badge!`,
        payload: { badgeId: badge._id, badgeType: badge.badgeType, title: badge.title },
      })
      emitToUser(studentUser._id, 'badge_awarded', { badgeId: badge._id, badgeType: badge.badgeType, title: badge.title })
    }

    // Notify the tutor who submitted
    if (badge.submittedBy && badge.submittedBy.toString() !== req.userId.toString()) {
      await createNotification({
        userId: badge.submittedBy,
        type: 'badge_awarded',
        title: 'Badge Approved',
        body: `The "${badge.title}" badge for ${populated.studentId?.name} has been approved.`,
        payload: { badgeId: badge._id },
      })
      emitToUser(badge.submittedBy, 'badge_approved', { badgeId: badge._id })
    }

    await logActivity({
      level: 'info', category: 'badge', action: 'badge_approved',
      message: `Badge "${badge.title}" approved for ${populated.studentId?.name}`,
      req,
    })

    res.json(populated)
  } catch (err) {
    console.error('Approve badge error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function rejectBadge(req, res) {
  try {
    const badge = await Badge.findById(req.params.id)
    if (!badge) return res.status(404).json({ error: 'Badge not found' })
    if (badge.status !== 'pending') return res.status(400).json({ error: 'Badge already reviewed' })

    badge.status = 'rejected'
    badge.rejectionReason = req.body.reason || ''
    await badge.save()

    // Notify the tutor who submitted
    if (badge.submittedBy) {
      await createNotification({
        userId: badge.submittedBy,
        type: 'system',
        title: 'Badge Rejected',
        body: `The "${badge.title}" badge was rejected.${badge.rejectionReason ? ' Reason: ' + badge.rejectionReason : ''}`,
        payload: { badgeId: badge._id },
      })
      emitToUser(badge.submittedBy, 'badge_rejected', { badgeId: badge._id })
    }

    await logActivity({
      level: 'info', category: 'badge', action: 'badge_rejected',
      message: `Badge "${badge.title}" rejected`,
      req,
    })

    res.json(badge)
  } catch (err) {
    console.error('Reject badge error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getUnacknowledgedBadges(req, res) {
  try {
    const studentId = req.user?.linkedStudentId
    if (!studentId) return res.json([])

    const badges = await Badge.find({
      studentId,
      status: 'approved',
      acknowledgedAt: { $exists: false },
    })
      .populate('studentId', 'name rollNo')
      .populate('submittedBy', 'displayName')
      .sort({ approvedAt: -1 })
      .lean()

    res.json(badges)
  } catch (err) {
    console.error('Get unacknowledged badges error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function acknowledgeBadge(req, res) {
  try {
    const badge = await Badge.findById(req.params.id)
    if (!badge) return res.status(404).json({ error: 'Badge not found' })

    badge.acknowledgedAt = new Date()
    await badge.save()

    res.json({ message: 'Badge acknowledged' })
  } catch (err) {
    console.error('Acknowledge badge error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getStudentBadges(req, res) {
  try {
    const badges = await Badge.find({
      studentId: req.params.studentId,
      status: 'approved',
    })
      .populate('submittedBy', 'displayName')
      .populate('approvedBy', 'displayName')
      .sort({ approvedAt: -1 })
      .lean()

    res.json(badges)
  } catch (err) {
    console.error('Get student badges error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

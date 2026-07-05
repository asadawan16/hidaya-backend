import Notice from '../models/Notice.js'
import Complaint from '../models/Complaint.js'
import WhatsappReminderLog from '../models/WhatsappReminderLog.js'
import TutorProfile from '../models/TutorProfile.js'
import Student from '../models/Student.js'
import Assignment from '../models/Assignment.js'
import User from '../models/User.js'
import { logActivity } from '../utils/activityLogger.js'
import { createNotification } from './portalNotificationController.js'
import { emitToAll } from '../config/socket.js'

// ─── Notices ───

export async function listNotices(req, res) {
  try {
    const { type, targetTutorId, targetStudentId, active } = req.query
    const filter = {}
    if (type) filter.type = type
    if (targetTutorId) filter.targetTutorId = targetTutorId
    if (targetStudentId) filter.targetStudentId = targetStudentId
    if (active !== undefined) filter.active = active === 'true'

    const records = await Notice.find(filter)
      .populate('targetTutorId', 'name tutorId')
      .populate('targetStudentId', 'name rollNo')
      .populate('createdBy', 'displayName')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()

    res.json(records)
  } catch (err) {
    console.error('List notices error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createNotice(req, res) {
  try {
    const { type, targetTutorId, targetStudentId, targetStudentIds, message, severity, category, autoDisableAt, classTime } = req.body
    if (!type || !message) return res.status(400).json({ error: 'Type and message are required' })

    const noticeCategory = category || 'information'
    const requiresAcknowledgment = noticeCategory === 'urgent'

    const notice = await Notice.create({
      type, targetTutorId, targetStudentId, targetStudentIds,
      message, severity: severity || 'info',
      category: noticeCategory,
      requiresAcknowledgment,
      autoDisableAt: autoDisableAt ? new Date(autoDisableAt) : undefined,
      classTime: classTime || undefined,
      createdBy: req.userId,
    })

    await logActivity({ level: 'info', category: 'notice', action: 'notice_created', message: `Notice created: ${type} (${noticeCategory})`, req })

    // Live-push: clients refetch their active notices (server-side targeting applies on fetch)
    try { emitToAll('notice_changed', { noticeId: notice._id, category: noticeCategory }) } catch {}

    // Notify the target tutor
    if (targetTutorId) {
      const tutor = await TutorProfile.findById(targetTutorId).lean()
      if (tutor?.userId) {
        await createNotification({
          userId: tutor.userId, type: 'notice',
          title: noticeCategory === 'urgent' ? '⚠️ Urgent Notice' : 'New Notice',
          body: message.slice(0, 100),
          payload: { noticeId: notice._id },
        })
      }
    }

    res.status(201).json(notice)
  } catch (err) {
    console.error('Create notice error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateNotice(req, res) {
  try {
    const notice = await Notice.findById(req.params.id)
    if (!notice) return res.status(404).json({ error: 'Notice not found' })

    const { message, severity, active } = req.body
    if (message !== undefined) notice.message = message
    if (severity !== undefined) notice.severity = severity
    if (active !== undefined) notice.active = active
    if (req.body.acknowledge) notice.acknowledgedAt = new Date()
    await notice.save()

    try { emitToAll('notice_changed', { noticeId: notice._id }) } catch {}

    res.json(notice)
  } catch (err) {
    console.error('Update notice error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteNotice(req, res) {
  try {
    const notice = await Notice.findByIdAndDelete(req.params.id)
    if (!notice) return res.status(404).json({ error: 'Notice not found' })
    try { emitToAll('notice_changed', { noticeId: notice._id }) } catch {}
    res.json({ message: 'Notice deleted' })
  } catch (err) {
    console.error('Delete notice error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Active Notices for Current User ───

export async function getActiveNoticesForUser(req, res) {
  try {
    const now = new Date()
    const baseFilter = { active: true }

    // Build OR conditions based on the user's role
    const orConditions = []

    // Global notices (no specific target)
    orConditions.push({ targetTutorId: { $exists: false }, targetStudentId: { $exists: false }, targetStudentIds: { $size: 0 } })
    orConditions.push({ targetTutorId: null, targetStudentId: null, targetStudentIds: { $size: 0 } })

    // If user is linked to a tutor profile, get tutor-targeted notices
    if (req.user.linkedTutorId) {
      orConditions.push({ targetTutorId: req.user.linkedTutorId })

      // Student-specific notices for students assigned to this tutor
      const assignments = await Assignment.find({ tutorId: req.user.linkedTutorId, endDate: null }).select('studentId').lean()
      const assignedStudentIds = assignments.map(a => a.studentId)
      if (assignedStudentIds.length > 0) {
        orConditions.push({ category: 'student_specific', targetStudentIds: { $in: assignedStudentIds } })
      }
    }

    const notices = await Notice.find({ ...baseFilter, $or: orConditions })
      .populate('targetTutorId', 'name tutorId')
      .populate('targetStudentId', 'name rollNo')
      .populate('targetStudentIds', 'name rollNo')
      .populate('createdBy', 'displayName')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()

    // Filter out expired temporary/information notices
    const filtered = notices.filter(n => {
      if (n.autoDisableAt && new Date(n.autoDisableAt) <= now) return false
      return true
    })

    // Mark which notices the current user has already acknowledged
    const userId = req.userId.toString()
    const enriched = filtered.map(n => ({
      ...n,
      userAcknowledged: n.acknowledgedBy?.some(a => a.userId?.toString() === userId) || false,
    }))

    res.json(enriched)
  } catch (err) {
    console.error('Get active notices error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function acknowledgeNotice(req, res) {
  try {
    const notice = await Notice.findById(req.params.id)
    if (!notice) return res.status(404).json({ error: 'Notice not found' })

    // Check if already acknowledged by this user
    const already = notice.acknowledgedBy.some(a => a.userId?.toString() === req.userId.toString())
    if (!already) {
      notice.acknowledgedBy.push({ userId: req.userId, acknowledgedAt: new Date() })
      await notice.save()
    }

    res.json({ success: true })
  } catch (err) {
    console.error('Acknowledge notice error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getNoticeAckStatus(req, res) {
  try {
    const notice = await Notice.findById(req.params.id)
      .populate('acknowledgedBy.userId', 'displayName email')
      .lean()
    if (!notice) return res.status(404).json({ error: 'Notice not found' })

    // Get target users who should acknowledge
    let targetUsers = []
    if (notice.targetTutorId) {
      const tutor = await TutorProfile.findById(notice.targetTutorId).populate('userId', 'displayName email').lean()
      if (tutor?.userId) targetUsers.push({ userId: tutor.userId._id, displayName: tutor.userId.displayName || tutor.name })
    } else if (notice.type === 'teacher') {
      // All active tutors
      const tutors = await TutorProfile.find({ status: 'active' }).populate('userId', 'displayName email').lean()
      targetUsers = tutors.filter(t => t.userId).map(t => ({ userId: t.userId._id, displayName: t.userId.displayName || t.name }))
    }

    const ackUserIds = new Set(notice.acknowledgedBy.map(a => a.userId?._id?.toString()))
    const status = targetUsers.map(u => ({
      ...u,
      acknowledged: ackUserIds.has(u.userId.toString()),
      acknowledgedAt: notice.acknowledgedBy.find(a => a.userId?._id?.toString() === u.userId.toString())?.acknowledgedAt,
    }))

    res.json({
      total: targetUsers.length,
      acknowledged: status.filter(s => s.acknowledged).length,
      pending: status.filter(s => !s.acknowledged).length,
      users: status,
    })
  } catch (err) {
    console.error('Notice ack status error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Complaints ───

export async function listComplaints(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { studentId, againstTutorId, status } = req.query

    const filter = {}
    if (studentId) filter.studentId = studentId
    if (againstTutorId) filter.againstTutorId = againstTutorId
    if (status) filter.status = status

    const total = await Complaint.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1

    const records = await Complaint.find(filter)
      .populate('studentId', 'name rollNo')
      .populate('againstTutorId', 'name tutorId')
      .populate('createdBy', 'displayName')
      .sort({ createdAt: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: pg, pages })
  } catch (err) {
    console.error('List complaints error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createComplaint(req, res) {
  try {
    const data = req.body
    if (!data.studentId || !data.complainant || !data.text || !data.representative) {
      return res.status(400).json({ error: 'studentId, representative, complainant, and text are required' })
    }

    const complaint = await Complaint.create({ ...data, createdBy: req.userId })

    // Notify the tutor if complaint is against them
    if (data.againstTutorId) {
      try {
        const User = (await import('../models/User.js')).default
        const Notification = (await import('../models/Notification.js')).default
        const { emitToUser } = await import('../config/socket.js')

        const tutorUser = await User.findOne({ linkedTutorId: data.againstTutorId, status: 'active' })
        if (tutorUser) {
          const notif = await Notification.create({
            userId: tutorUser._id,
            type: 'complaint',
            title: 'New Complaint Filed',
            body: data.actionRequired
              ? `A complaint has been filed regarding your student. Action required: ${data.actionRequired}`
              : `A complaint has been filed regarding one of your students. Please review.`,
            payload: { complaintId: complaint._id, studentId: data.studentId },
          })
          // Live bell update — the client's SocketContext listens for 'notification'
          emitToUser(tutorUser._id, 'notification', notif)
          emitToUser(tutorUser._id, 'complaint_filed', { complaintId: complaint._id })
        }
      } catch {}
    }

    await logActivity({ level: 'warning', category: 'complaint', action: 'complaint_created', message: `Complaint filed for student ${data.studentId}`, req })
    res.status(201).json(complaint)
  } catch (err) {
    console.error('Create complaint error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function resolveComplaint(req, res) {
  try {
    const complaint = await Complaint.findById(req.params.id)
    if (!complaint) return res.status(404).json({ error: 'Complaint not found' })

    complaint.status = 'resolved'
    complaint.resolvedBy = req.userId
    complaint.resolvedAt = new Date()
    complaint.resolution = req.body.resolution || ''
    await complaint.save()

    // Notify the filer and the tutor the complaint was against
    const resolutionNote = complaint.resolution ? ` Resolution: ${complaint.resolution}` : ''
    if (complaint.createdBy && complaint.createdBy.toString() !== req.userId.toString()) {
      await createNotification({
        userId: complaint.createdBy,
        type: 'complaint',
        title: 'Complaint Resolved',
        body: `A complaint you filed has been resolved.${resolutionNote}`,
        payload: { complaintId: complaint._id },
      })
    }
    if (complaint.againstTutorId) {
      const tutorUser = await User.findOne({ linkedTutorId: complaint.againstTutorId, status: 'active' }).select('_id').lean()
      if (tutorUser && tutorUser._id.toString() !== req.userId.toString()) {
        await createNotification({
          userId: tutorUser._id,
          type: 'complaint',
          title: 'Complaint Resolved',
          body: `A complaint concerning you has been resolved.${resolutionNote}`,
          payload: { complaintId: complaint._id },
        })
      }
    }

    res.json(complaint)
  } catch (err) {
    console.error('Resolve complaint error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── WhatsApp Reminders ───

export async function sendWhatsappReminder(req, res) {
  try {
    const { studentId, tutorId } = req.body
    if (!studentId) return res.status(400).json({ error: 'studentId is required' })

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const existing = await WhatsappReminderLog.findOne({ studentId, sentDate: today })
    if (existing) {
      return res.status(400).json({ error: 'Reminder already sent today for this student' })
    }

    await WhatsappReminderLog.create({
      studentId, tutorId, sentDate: today, sentBy: req.userId,
    })

    // Get student's WhatsApp number
    const student = await Student.findById(studentId).lean()
    const whatsapp = student?.whatsappNumber || student?.phone || ''

    res.json({
      message: 'Reminder logged',
      whatsappUrl: whatsapp ? `https://wa.me/${whatsapp.replace(/[^0-9]/g, '')}` : null,
    })
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Reminder already sent today' })
    }
    console.error('WhatsApp reminder error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

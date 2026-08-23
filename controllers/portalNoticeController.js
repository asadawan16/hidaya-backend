import Notice from '../models/Notice.js'
import Complaint from '../models/Complaint.js'
import WhatsappReminderLog from '../models/WhatsappReminderLog.js'
import TutorProfile from '../models/TutorProfile.js'
import Student from '../models/Student.js'
import Assignment from '../models/Assignment.js'
import User from '../models/User.js'
import Role from '../models/Role.js'
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
    const { type, targetTutorId, targetStudentId, targetStudentIds, targetRoles, message, severity, category, autoDisableAt, classTime } = req.body
    if (!type || !message) return res.status(400).json({ error: 'Type and message are required' })

    const noticeCategory = category || 'information'
    const requiresAcknowledgment = noticeCategory === 'urgent'
    const roles = Array.isArray(targetRoles) ? targetRoles.filter(Boolean) : []

    const notice = await Notice.create({
      type, targetTutorId, targetStudentId, targetStudentIds,
      targetRoles: roles,
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

    // Notify users holding a targeted management role
    if (roles.length) {
      try {
        const roleDocs = await Role.find({ key: { $in: roles } }).select('_id').lean()
        const roleIds = roleDocs.map(r => r._id)
        if (roleIds.length) {
          const users = await User.find({ roles: { $in: roleIds }, status: 'active' }).select('_id').lean()
          await Promise.all(users.map(u => createNotification({
            userId: u._id, type: 'notice',
            title: noticeCategory === 'urgent' ? '⚠️ Urgent Notice' : 'New Notice',
            body: message.slice(0, 100),
            payload: { noticeId: notice._id },
          })))
        }
      } catch (e) { console.error('Notice role notify error:', e.message) }
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

    // A notice is "role-targeted" when it has a non-empty targetRoles array.
    // Global broadcasts must exclude those so role notices only reach their roles.
    const notRoleTargeted = { $or: [{ targetRoles: { $exists: false } }, { targetRoles: { $size: 0 } }] }

    // Audience type: students must only ever see student-typed global notices.
    // Staff (no linkedStudentId) see teacher-typed globals. Without this filter,
    // un-targeted teacher announcements leaked to students. See mobile plan §9.
    const audienceType = req.user.linkedStudentId ? 'student' : 'teacher'

    // Global notices (no specific target, and not role-targeted) — type-scoped.
    orConditions.push({ type: audienceType, targetTutorId: { $exists: false }, targetStudentId: { $exists: false }, targetStudentIds: { $size: 0 }, ...notRoleTargeted })
    orConditions.push({ type: audienceType, targetTutorId: null, targetStudentId: null, targetStudentIds: { $size: 0 }, ...notRoleTargeted })

    // Role-targeted notices for the current user's roles
    const roleKeys = (req.user.roles || []).map(r => r.key).filter(Boolean)
    if (roleKeys.length) {
      orConditions.push({ targetRoles: { $in: roleKeys } })
    }

    // If user is linked to a student, deliver notices addressed to that student.
    if (req.user.linkedStudentId) {
      orConditions.push({ targetStudentId: req.user.linkedStudentId })
      orConditions.push({ targetStudentIds: req.user.linkedStudentId })
    }

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
    const { studentId, againstTutorId, status, visibility } = req.query

    const filter = {}
    if (studentId) filter.studentId = studentId
    if (againstTutorId) filter.againstTutorId = againstTutorId
    if (status) filter.status = status
    if (visibility) filter.visibility = visibility
    // Management-only complaints never reach tutors.
    if (req.user.linkedTutorId) filter.visibility = { $ne: 'management_only' }

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

    // Honor the requested outcome so "Dismiss" actually dismisses (was hard-coded).
    const status = req.body.status === 'dismissed' ? 'dismissed' : 'resolved'
    complaint.status = status
    complaint.resolvedBy = req.userId
    complaint.resolvedAt = new Date()
    complaint.resolution = req.body.resolution || ''
    await complaint.save()

    const verb = status === 'dismissed' ? 'dismissed' : 'resolved'
    // Notify the filer and the tutor the complaint was against
    const resolutionNote = complaint.resolution ? ` Resolution: ${complaint.resolution}` : ''
    if (complaint.createdBy && complaint.createdBy.toString() !== req.userId.toString()) {
      await createNotification({
        userId: complaint.createdBy,
        type: 'complaint',
        title: `Complaint ${verb === 'dismissed' ? 'Dismissed' : 'Resolved'}`,
        body: `A complaint you filed has been ${verb}.${resolutionNote}`,
        payload: { complaintId: complaint._id },
      })
    }
    if (complaint.againstTutorId) {
      const tutorUser = await User.findOne({ linkedTutorId: complaint.againstTutorId, status: 'active' }).select('_id').lean()
      if (tutorUser && tutorUser._id.toString() !== req.userId.toString()) {
        await createNotification({
          userId: tutorUser._id,
          type: 'complaint',
          title: `Complaint ${verb === 'dismissed' ? 'Dismissed' : 'Resolved'}`,
          body: `A complaint concerning you has been ${verb}.${resolutionNote}`,
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

// PATCH /portal/complaints/:id — edit message text, formatting, priority, category.
export async function updateComplaint(req, res) {
  try {
    const complaint = await Complaint.findById(req.params.id)
    if (!complaint) return res.status(404).json({ error: 'Complaint not found' })

    const editable = ['text', 'fontSize', 'bold', 'priority', 'category', 'representative', 'complainant', 'actionRequired', 'visibility']
    for (const key of editable) {
      if (req.body[key] !== undefined) complaint[key] = req.body[key]
    }
    await complaint.save()

    await logActivity({ category: 'complaint', action: 'complaint_updated', message: `Complaint ${complaint._id} edited`, req })

    const populated = await Complaint.findById(complaint._id)
      .populate('studentId', 'name rollNo')
      .populate('againstTutorId', 'name tutorId')
      .populate('createdBy', 'displayName')
      .lean()
    res.json(populated)
  } catch (err) {
    console.error('Update complaint error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// DELETE /portal/complaints/:id
export async function deleteComplaint(req, res) {
  try {
    const complaint = await Complaint.findByIdAndDelete(req.params.id)
    if (!complaint) return res.status(404).json({ error: 'Complaint not found' })
    await logActivity({ level: 'warning', category: 'complaint', action: 'complaint_deleted', message: `Complaint ${req.params.id} deleted`, req })
    res.json({ success: true })
  } catch (err) {
    console.error('Delete complaint error:', err)
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

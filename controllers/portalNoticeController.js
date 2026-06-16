import Notice from '../models/Notice.js'
import Complaint from '../models/Complaint.js'
import WhatsappReminderLog from '../models/WhatsappReminderLog.js'
import TutorProfile from '../models/TutorProfile.js'
import Student from '../models/Student.js'
import { logActivity } from '../utils/activityLogger.js'
import { createNotification } from './portalNotificationController.js'

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
    const { type, targetTutorId, targetStudentId, message, severity } = req.body
    if (!type || !message) return res.status(400).json({ error: 'Type and message are required' })

    const notice = await Notice.create({
      type, targetTutorId, targetStudentId,
      message, severity: severity || 'info',
      createdBy: req.userId,
    })

    await logActivity({ level: 'info', category: 'notice', action: 'notice_created', message: `Notice created: ${type}`, req })

    // Notify the target tutor
    if (targetTutorId) {
      const tutor = await TutorProfile.findById(targetTutorId).lean()
      if (tutor?.userId) {
        await createNotification({
          userId: tutor.userId, type: 'notice',
          title: 'New Notice', body: message.slice(0, 100),
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

    res.json(notice)
  } catch (err) {
    console.error('Update notice error:', err)
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

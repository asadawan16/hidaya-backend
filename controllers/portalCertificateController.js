import Certificate from '../models/Certificate.js'
import Student from '../models/Student.js'
import Notification from '../models/Notification.js'
import { logActivity } from '../utils/activityLogger.js'
import { emitToUser } from '../config/socket.js'

const POPULATE = [
  { path: 'studentId', select: 'name rollNo country' },
  { path: 'submittedBy', select: 'displayName' },
  { path: 'issuedBy', select: 'displayName' },
  { path: 'approvedBy', select: 'displayName' },
]

export async function listCertificates(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { studentId, type, status } = req.query

    const filter = {}

    // Scope: students see only their own approved certificates
    if (req.user.linkedStudentId) {
      filter.studentId = req.user.linkedStudentId
      filter.status = 'approved'
    } else if (req.user.linkedTutorId) {
      // Tutors see their own submissions + approved ones
      if (status) {
        filter.status = status
        filter.submittedBy = req.userId
      } else {
        filter.$or = [
          { submittedBy: req.userId },
          { status: 'approved' },
        ]
      }
      if (studentId) filter.studentId = studentId
    } else {
      // Admin/QCI see everything
      if (studentId) filter.studentId = studentId
      if (status) filter.status = status
    }
    if (type) filter.type = type

    const total = await Certificate.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1

    const records = await Certificate.find(filter)
      .populate(POPULATE)
      .sort({ createdAt: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean()

    // Status stats for badge counts
    const statsFilter = {}
    if (req.user.linkedStudentId) {
      statsFilter.studentId = req.user.linkedStudentId
    }
    const statusStats = await Certificate.aggregate([
      { $match: statsFilter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])

    res.json({ records, total, page: pg, pages, statusStats })
  } catch (err) {
    console.error('List certificates error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Create certificate — auto-approves if user has certificate.approve permission
export async function createCertificate(req, res) {
  try {
    const { studentId, type, title, details, templateDesign, meta } = req.body
    if (!studentId || !type || !title) {
      return res.status(400).json({ error: 'studentId, type, and title are required' })
    }

    const student = await Student.findById(studentId)
    if (!student) return res.status(404).json({ error: 'Student not found' })

    // If user can approve, issue directly as approved
    const canApprove = req.userPermissions?.has('certificate.approve')
    const cert = await Certificate.create({
      studentId, type, title, details: details || '',
      templateDesign: templateDesign || 'classic',
      meta: meta || {},
      status: canApprove ? 'approved' : 'pending',
      submittedBy: req.userId,
      issuedBy: req.userId,
      ...(canApprove ? { approvedBy: req.userId, approvedAt: new Date() } : {}),
    })

    await logActivity({
      level: 'info', category: 'certificate',
      action: canApprove ? 'certificate_issued' : 'certificate_submitted',
      message: canApprove
        ? `Certificate "${title}" issued to ${student.name} (${student.rollNo})`
        : `Certificate "${title}" submitted for ${student.name} (${student.rollNo}) — pending approval`,
      req,
    })

    // Live-push to the student when issued directly as approved
    if (canApprove && student.userId) {
      try { emitToUser(student.userId.toString(), 'certificate_awarded', { certificateId: cert._id, title }) } catch {}
    }

    const populated = await Certificate.findById(cert._id).populate(POPULATE).lean()
    res.status(201).json(populated)
  } catch (err) {
    console.error('Create certificate error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Bulk submit certificates
export async function bulkCreateCertificates(req, res) {
  try {
    const { studentIds, type, title, details, templateDesign } = req.body
    if (!studentIds?.length || !type || !title) {
      return res.status(400).json({ error: 'studentIds, type, and title are required' })
    }
    if (studentIds.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 students per bulk operation' })
    }

    const students = await Student.find({ _id: { $in: studentIds } }).select('name rollNo userId').lean()
    if (students.length === 0) return res.status(404).json({ error: 'No valid students found' })

    const canApprove = req.userPermissions?.has('certificate.approve')
    const docs = students.map(s => ({
      studentId: s._id,
      type, title, details: details || '',
      templateDesign: templateDesign || 'classic',
      status: canApprove ? 'approved' : 'pending',
      submittedBy: req.userId,
      issuedBy: req.userId,
      ...(canApprove ? { approvedBy: req.userId, approvedAt: new Date() } : {}),
    }))

    const certs = await Certificate.insertMany(docs)

    // Live-push to each student when issued directly as approved
    if (canApprove) {
      const userByStudent = new Map(students.filter(s => s.userId).map(s => [s._id.toString(), s.userId.toString()]))
      for (const c of certs) {
        const uid = userByStudent.get(c.studentId.toString())
        if (uid) {
          try { emitToUser(uid, 'certificate_awarded', { certificateId: c._id, title }) } catch {}
        }
      }
    }

    await logActivity({
      level: 'info', category: 'certificate', action: 'bulk_certificates_submitted',
      message: `Bulk certificates "${title}" submitted for ${certs.length} students — pending approval`,
      req,
    })

    res.status(201).json({ count: certs.length, message: `${certs.length} certificates submitted for approval` })
  } catch (err) {
    console.error('Bulk create certificates error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getCertificate(req, res) {
  try {
    const cert = await Certificate.findById(req.params.id).populate(POPULATE).lean()
    if (!cert) return res.status(404).json({ error: 'Certificate not found' })

    // Students can only view their own approved certificates
    if (req.user.linkedStudentId) {
      if (cert.studentId._id.toString() !== req.user.linkedStudentId.toString() || cert.status !== 'approved') {
        return res.status(403).json({ error: 'Access denied' })
      }
    }

    res.json(cert)
  } catch (err) {
    console.error('Get certificate error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function approveCertificate(req, res) {
  try {
    const cert = await Certificate.findById(req.params.id)
    if (!cert) return res.status(404).json({ error: 'Certificate not found' })
    if (cert.status !== 'pending') {
      return res.status(400).json({ error: `Certificate is already ${cert.status}` })
    }

    cert.status = 'approved'
    cert.approvedBy = req.userId
    cert.approvedAt = new Date()
    cert.issuedDate = new Date()
    cert.rejectionReason = ''
    await cert.save()

    // Notify the student (if they have a portal user account)
    const student = await Student.findById(cert.studentId).select('name userId').lean()
    if (student?.userId) {
      await Notification.create({
        userId: student.userId,
        type: 'certificate_issued',
        title: 'Certificate Issued!',
        body: `Congratulations! You have been awarded: ${cert.title}`,
        payload: { certificateId: cert._id, certificateTitle: cert.title, certificateType: cert.type, templateDesign: cert.templateDesign },
      })
      try { emitToUser(student.userId.toString(), 'certificate_awarded', { certificateId: cert._id, title: cert.title }) } catch {}
    }

    await logActivity({
      level: 'info', category: 'certificate', action: 'certificate_approved',
      message: `Certificate "${cert.title}" approved for ${student?.name || 'student'}`,
      req,
    })

    const populated = await Certificate.findById(cert._id).populate(POPULATE).lean()
    res.json(populated)
  } catch (err) {
    console.error('Approve certificate error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function rejectCertificate(req, res) {
  try {
    const cert = await Certificate.findById(req.params.id)
    if (!cert) return res.status(404).json({ error: 'Certificate not found' })
    if (cert.status !== 'pending') {
      return res.status(400).json({ error: `Certificate is already ${cert.status}` })
    }

    cert.status = 'rejected'
    cert.rejectionReason = req.body.reason || ''
    await cert.save()

    await logActivity({
      level: 'info', category: 'certificate', action: 'certificate_rejected',
      message: `Certificate "${cert.title}" rejected${req.body.reason ? `: ${req.body.reason}` : ''}`,
      req,
    })

    const populated = await Certificate.findById(cert._id).populate(POPULATE).lean()
    res.json(populated)
  } catch (err) {
    console.error('Reject certificate error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Get unacknowledged certificates for the logged-in student
export async function getUnacknowledgedCerts(req, res) {
  try {
    if (!req.user.linkedStudentId) return res.json([])

    const certs = await Certificate.find({
      studentId: req.user.linkedStudentId,
      status: 'approved',
      acknowledgedAt: { $exists: false },
    }).populate(POPULATE).sort({ approvedAt: -1 }).lean()

    res.json(certs)
  } catch (err) {
    console.error('Unacknowledged certs error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Acknowledge a certificate (student dismisses the celebration modal)
export async function acknowledgeCertificate(req, res) {
  try {
    const cert = await Certificate.findById(req.params.id)
    if (!cert) return res.status(404).json({ error: 'Certificate not found' })

    // Only the student it belongs to can acknowledge
    if (req.user.linkedStudentId?.toString() !== cert.studentId.toString()) {
      return res.status(403).json({ error: 'Access denied' })
    }

    cert.acknowledgedAt = new Date()
    await cert.save()
    res.json({ message: 'Certificate acknowledged' })
  } catch (err) {
    console.error('Acknowledge certificate error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteCertificate(req, res) {
  try {
    const cert = await Certificate.findByIdAndDelete(req.params.id)
    if (!cert) return res.status(404).json({ error: 'Certificate not found' })
    res.json({ message: 'Certificate deleted' })
  } catch (err) {
    console.error('Delete certificate error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

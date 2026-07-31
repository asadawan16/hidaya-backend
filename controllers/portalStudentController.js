import Student from '../models/Student.js'
import StudentStatusHistory from '../models/StudentStatusHistory.js'
import Family from '../models/Family.js'
import StudentRelationship from '../models/StudentRelationship.js'
import Complaint from '../models/Complaint.js'
import ClassSession from '../models/ClassSession.js'
import Assessment from '../models/Assessment.js'
import AssessmentTemplate from '../models/AssessmentTemplate.js'
import PermanentLesson from '../models/PermanentLesson.js'
import CurriculumItem from '../models/CurriculumItem.js'
import Assignment from '../models/Assignment.js'
import LessonEntry from '../models/LessonEntry.js'
import Certificate from '../models/Certificate.js'
import Badge from '../models/Badge.js'
import User from '../models/User.js'
import Role from '../models/Role.js'
import { logActivity } from '../utils/activityLogger.js'
import { sendToUser, portalWelcomeEmail } from '../services/mailer.js'
import { createNotification } from './portalNotificationController.js'

// Generate next roll number
async function generateRollNo() {
  const last = await Student.findOne({ rollNo: { $regex: /^HID\d+$/ } })
    .sort({ rollNo: -1 })
    .select('rollNo')
    .lean()

  if (!last) return 'HID01'
  const num = parseInt(last.rollNo.replace('HID', ''), 10) + 1
  return `HID${String(num).padStart(2, '0')}`
}

export async function listStudents(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { search, status, course, sort } = req.query

    const filter = {}

    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [
        { name: regex },
        { rollNo: regex },
        { email: regex },
        { phone: regex },
        { parentsName: regex },
      ]
    }

    if (status) filter.status = status
    if (course) filter.courseLabels = course

    const total = await Student.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    let sortObj = { createdAt: -1 }
    if (sort === 'name') sortObj = { name: 1 }
    if (sort === 'rollNo') sortObj = { rollNo: 1 }
    if (sort === 'status') sortObj = { status: 1 }

    const records = await Student.find(filter)
      .populate('familyId', 'familyCode')
      .sort(sortObj)
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    // Get stats
    const stats = await Student.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])
    const statusCounts = {}
    stats.forEach(s => { statusCounts[s._id] = s.count })

    // Strip billing data if the user lacks finance.read permission
    const cleanRecords = req.userPermissions?.has('finance.read')
      ? records
      : records.map(({ billing, ...rest }) => rest)

    res.json({ records: cleanRecords, total, page: safePage, pages, statusCounts })
  } catch (err) {
    console.error('List students error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Lightweight typeahead picker for dropdowns — supports 1000+ students via search
export async function pickerStudents(req, res) {
  try {
    const lim = Math.max(1, Math.min(30, parseInt(req.query.limit, 10) || 20))
    const { q, status, ids } = req.query

    const filter = {}
    if (status) filter.status = status

    if (ids) {
      // Hydration mode: resolve already-selected values regardless of q
      const idList = String(ids).split(',').map(s => s.trim()).filter(Boolean).slice(0, 50)
      filter._id = { $in: idList }
    } else if (q) {
      const regex = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ name: regex }, { rollNo: regex }]
    }

    const records = await Student.find(filter)
      .select('name rollNo status')
      .sort({ name: 1 })
      .limit(ids ? 50 : lim)
      .lean()

    res.json(records)
  } catch (err) {
    console.error('Student picker error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getStudent(req, res) {
  try {
    const student = await Student.findById(req.params.id)
      .populate('familyId')
      .populate('userId', 'email displayName status')
      .populate('referredByStudent', 'name rollNo status')
      .lean()

    if (!student) return res.status(404).json({ error: 'Student not found' })

    // Get status history
    const statusHistory = await StudentStatusHistory.find({ studentId: student._id })
      .populate('changedBy', 'displayName email')
      .sort({ createdAt: -1 })
      .lean()

    // Get relationships
    const relationships = await StudentRelationship.find({
      $or: [{ studentA: student._id }, { studentB: student._id }],
    })
      .populate('studentA', 'name rollNo')
      .populate('studentB', 'name rollNo')
      .lean()

    // Get family members
    let familyMembers = []
    if (student.familyId) {
      familyMembers = await Student.find({
        familyId: student.familyId._id,
        _id: { $ne: student._id },
      }).select('name rollNo status courseLabels').lean()
    }

    // Strip billing data if the user lacks finance.read permission
    const result = { ...student, statusHistory, relationships, familyMembers }
    if (!req.userPermissions?.has('finance.read')) {
      delete result.billing
    }

    res.json(result)
  } catch (err) {
    console.error('Get student error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Live roll-no availability check (and a suggested next roll no when none given).
export async function checkRollNo(req, res) {
  try {
    const raw = (req.query.rollNo || '').trim()
    const { excludeId } = req.query
    if (!raw) {
      return res.json({ available: false, suggestion: await generateRollNo() })
    }
    const filter = { rollNo: raw }
    if (excludeId) filter._id = { $ne: excludeId }
    const existing = await Student.findOne(filter).select('_id').lean()
    res.json({ available: !existing })
  } catch (err) {
    console.error('Check roll no error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createStudent(req, res) {
  try {
    const { createPortalAccount, portalPassword, ...data } = req.body

    if (!data.name) {
      return res.status(400).json({ error: 'Student name is required' })
    }

    // Empty referrer must be unset — '' is not a castable ObjectId
    if (!data.referredByStudent) delete data.referredByStudent

    // Blank joining date → let the model default (today) apply
    if (!data.joiningDate) delete data.joiningDate

    // Validate portal-account inputs up-front so we never create an orphan student
    let studentRole = null
    let portalEmail = ''
    if (createPortalAccount) {
      portalEmail = (data.email || '').toLowerCase().trim()
      if (!portalEmail) {
        return res.status(400).json({ error: 'An email is required to create a portal account for this student' })
      }
      if (!portalPassword || portalPassword.length < 6) {
        return res.status(400).json({ error: 'Portal password must be at least 6 characters' })
      }
      const existingUser = await User.findOne({ email: portalEmail })
      if (existingUser) {
        return res.status(400).json({ error: 'A portal account with this email already exists' })
      }
      studentRole = await Role.findOne({ key: 'student' })
      if (!studentRole) {
        return res.status(400).json({ error: 'Student role not found — please seed roles first' })
      }
    }

    // Auto-generate roll number if not provided
    if (!data.rollNo) {
      data.rollNo = await generateRollNo()
    } else {
      const existing = await Student.findOne({ rollNo: data.rollNo })
      if (existing) {
        return res.status(400).json({ error: 'Roll number already exists' })
      }
    }

    const student = await Student.create(data)

    // If family is linked, add student to family members array
    if (data.familyId) {
      await Family.findByIdAndUpdate(data.familyId, {
        $addToSet: { members: student._id },
      })
    }

    // Create initial status history
    await StudentStatusHistory.create({
      studentId: student._id,
      status: student.status,
      effectiveDate: new Date(),
      comment: 'Student created',
      changedBy: req.userId,
    })

    // Create a linked portal (login) account if requested
    let portalAccount = null
    if (createPortalAccount && studentRole) {
      const user = await User.create({
        email: portalEmail,
        password: portalPassword,
        displayName: student.name,
        phone: student.phone || '',
        roles: [studentRole._id],
        status: 'active',
        linkedStudentId: student._id,
      })

      student.userId = user._id
      await student.save()

      // Email the credentials to the address used for the account
      const { subject, html } = portalWelcomeEmail({
        displayName: student.name,
        email: portalEmail,
        password: portalPassword,
        rollNo: student.rollNo,
      })
      await sendToUser({ to: portalEmail, subject, html })

      await createNotification({
        userId: user._id,
        type: 'user_account',
        title: 'Welcome to Hidaya Online',
        body: `Assalamu Alaikum ${student.name}! Your student portal account is ready.`,
        payload: { rollNo: student.rollNo },
      })

      portalAccount = { created: true, email: portalEmail, userId: user._id }
    }

    await logActivity({
      level: 'info',
      category: 'student_management',
      action: 'student_created',
      message: `Student created: ${student.name} (${student.rollNo})${portalAccount ? ' + portal account' : ''}`,
      req,
      meta: { studentId: student._id },
    })

    res.status(201).json({ ...student.toObject(), portalAccount })
  } catch (err) {
    console.error('Create student error:', err)
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Roll number already exists' })
    }
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateStudent(req, res) {
  try {
    const student = await Student.findById(req.params.id)
    if (!student) return res.status(404).json({ error: 'Student not found' })

    const data = req.body
    const oldStatus = student.status
    const oldFamilyId = student.familyId?.toString()

    // An empty referrer clears the link — '' is not a castable ObjectId
    if (data.referredByStudent === '') data.referredByStudent = null

    // Never let a blank joining date wipe an existing one
    if (data.joiningDate === '') delete data.joiningDate

    // Update fields
    const allowedFields = [
      'name', 'parentsName', 'dob', 'joiningDate', 'country', 'timezone',
      'guardians', 'whatsappNumber', 'courseLabels', 'placementLevel',
      'sect', 'specialNeeds', 'familyId', 'referredBy', 'referredByStudent', 'billing',
      'status', 'email', 'phone', 'notes', 'userId',
      'performanceFlag', 'performanceTags', 'freshness',
      'leaveStartDate', 'expectedResumeDate',
    ]

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        student[field] = data[field]
      }
    }

    await student.save()

    // Sync family members arrays when familyId changes
    const newFamilyId = student.familyId?.toString()
    if (data.familyId !== undefined && oldFamilyId !== newFamilyId) {
      // Remove from old family
      if (oldFamilyId) {
        await Family.findByIdAndUpdate(oldFamilyId, {
          $pull: { members: student._id },
        })
      }
      // Add to new family
      if (newFamilyId) {
        await Family.findByIdAndUpdate(newFamilyId, {
          $addToSet: { members: student._id },
        })
      }
    }

    // Track status change
    if (data.status && data.status !== oldStatus) {
      await StudentStatusHistory.create({
        studentId: student._id,
        status: data.status,
        effectiveDate: new Date(),
        comment: data.statusComment || '',
        changedBy: req.userId,
      })
    }

    await logActivity({
      level: 'info',
      category: 'student_management',
      action: 'student_updated',
      message: `Student updated: ${student.name} (${student.rollNo})`,
      req,
      meta: { studentId: student._id },
    })

    res.json(student)
  } catch (err) {
    console.error('Update student error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteStudent(req, res) {
  try {
    const student = await Student.findById(req.params.id)
    if (!student) return res.status(404).json({ error: 'Student not found' })

    // Remove from family members array
    if (student.familyId) {
      await Family.findByIdAndUpdate(student.familyId, {
        $pull: { members: student._id },
      })
    }

    await Student.findByIdAndDelete(req.params.id)
    await StudentStatusHistory.deleteMany({ studentId: req.params.id })
    await StudentRelationship.deleteMany({
      $or: [{ studentA: req.params.id }, { studentB: req.params.id }],
    })

    await logActivity({
      level: 'warning',
      category: 'student_management',
      action: 'student_deleted',
      message: `Student deleted: ${student.name} (${student.rollNo})`,
      req,
      meta: { studentId: student._id },
    })

    res.json({ message: 'Student deleted' })
  } catch (err) {
    console.error('Delete student error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function changeStudentStatus(req, res) {
  try {
    const { status, comment } = req.body
    if (!status) return res.status(400).json({ error: 'Status is required' })

    const student = await Student.findById(req.params.id)
    if (!student) return res.status(404).json({ error: 'Student not found' })

    const oldStatus = student.status
    student.status = status
    await student.save()

    await StudentStatusHistory.create({
      studentId: student._id,
      status,
      effectiveDate: new Date(),
      comment: comment || '',
      changedBy: req.userId,
    })

    await logActivity({
      level: 'info',
      category: 'student_management',
      action: 'student_status_changed',
      message: `Student ${student.rollNo} status: ${oldStatus} → ${status}`,
      req,
      meta: { studentId: student._id, oldStatus, newStatus: status },
    })

    if (student.userId) {
      const { createNotification } = await import('./portalNotificationController.js')
      await createNotification({
        userId: student.userId,
        type: 'system',
        title: 'Account Status Updated',
        body: `Your enrollment status has changed to "${status}".${comment ? ' Note: ' + comment : ''}`,
        payload: { studentId: student._id, status },
      })
    }

    res.json({ message: 'Status updated', student })
  } catch (err) {
    console.error('Change student status error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getStudentStats(req, res) {
  try {
    const [statusStats, courseStats, total] = await Promise.all([
      Student.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Student.aggregate([{ $unwind: '$courseLabels' }, { $group: { _id: '$courseLabels', count: { $sum: 1 } } }]),
      Student.countDocuments(),
    ])

    res.json({ total, statusStats, courseStats })
  } catch (err) {
    console.error('Student stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Extended Student Detail ───

export async function getStudentDetailExtended(req, res) {
  try {
    const student = await Student.findById(req.params.id)
      .populate('familyId')
      .populate('userId', 'displayName email')
      .populate('referredByStudent', 'name rollNo status')
      .populate('adminNotes.createdBy', 'displayName')
      .populate('feedbacks.createdBy', 'displayName')
      .lean()

    if (!student) return res.status(404).json({ error: 'Student not found' })

    // Date filter support
    const { dateFrom, dateTo } = req.query
    const dateFilter = {}
    if (dateFrom) dateFilter.$gte = new Date(dateFrom)
    if (dateTo) dateFilter.$lte = new Date(dateTo)
    const hasDateFilter = Object.keys(dateFilter).length > 0

    // Strip billing if user lacks finance.read
    if (!req.userPermissions.has('finance.read')) {
      delete student.billing
    }

    // Parallel fetch all extended data
    const [
      statusHistory,
      relationships,
      familyMembers,
      complaints,
      classStats,
      assessments,
      curriculumProgress,
      assignments,
      lessonsByTutor,
      certificates,
      badges,
    ] = await Promise.all([
      // Status history
      StudentStatusHistory.find({ studentId: student._id })
        .populate('changedBy', 'displayName')
        .sort({ createdAt: -1 })
        .lean(),

      // Relationships
      StudentRelationship.find({ $or: [{ studentA: student._id }, { studentB: student._id }] })
        .populate('studentA', 'name rollNo status')
        .populate('studentB', 'name rollNo status')
        .lean(),

      // Family members (if family exists)
      student.familyId
        ? Student.find({ familyId: student.familyId._id, _id: { $ne: student._id } })
            .select('name rollNo status courseLabels')
            .lean()
        : [],

      // Complaints (exclude from tutors if they are the target)
      req.userPermissions.has('complaint.read')
        ? Complaint.find({ studentId: student._id })
            .populate('againstTutorId', 'name tutorId')
            .populate('createdBy', 'displayName')
            .populate('resolvedBy', 'displayName')
            .sort({ createdAt: -1 })
            .lean()
        : [],

      // Class statistics
      ClassSession.aggregate([
        { $match: { studentId: student._id, ...(hasDateFilter ? { date: dateFilter } : {}) } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $eq: ['$status', 'missed'] }, 1, 0] } },
            scheduled: { $sum: { $cond: [{ $eq: ['$status', 'scheduled'] }, 1, 0] } },
            started: { $sum: { $cond: [{ $eq: ['$status', 'started'] }, 1, 0] } },
          },
        },
      ]),

      // Assessments
      Assessment.find({ studentId: student._id, ...(hasDateFilter ? { date: dateFilter } : {}) })
        .populate('templateId', 'name')
        .populate('testTeacherId', 'name tutorId')
        .sort({ date: -1 })
        .lean(),

      // Curriculum progress: approved permanent lessons grouped by track
      (async () => {
        const approved = await PermanentLesson.find({ studentId: student._id, status: 'approved', ...(hasDateFilter ? { completedDate: dateFilter } : {}) })
          .populate('curriculumItemId', 'track type label order')
          .populate('tutorId', 'name tutorId')
          .sort({ completedDate: -1 })
          .lean()

        // Get all curriculum items to compute total per track
        const allItems = await CurriculumItem.find({ active: { $ne: false } })
          .select('track type label order')
          .lean()

        const trackTotals = {}
        allItems.forEach(it => {
          if (!trackTotals[it.track]) trackTotals[it.track] = 0
          trackTotals[it.track]++
        })

        const completedByTrack = {}
        approved.forEach(pl => {
          const track = pl.curriculumItemId?.track
          if (!track) return
          if (!completedByTrack[track]) completedByTrack[track] = []
          completedByTrack[track].push({
            item: pl.curriculumItemId,
            completedDate: pl.completedDate,
            tutorName: pl.tutorId?.name,
          })
        })

        return Object.keys(trackTotals).map(track => ({
          track,
          total: trackTotals[track],
          completed: completedByTrack[track]?.length || 0,
          items: completedByTrack[track] || [],
        }))
      })(),

      // Assignments (tutor history)
      Assignment.find({ studentId: student._id })
        .populate('tutorId', 'name tutorId')
        .populate('assignedBy', 'displayName')
        .sort({ startDate: -1 })
        .lean(),

      // Lesson entries per tutor
      LessonEntry.aggregate([
        { $match: { studentId: student._id, ...(hasDateFilter ? { date: dateFilter } : {}) } },
        {
          $group: {
            _id: '$tutorId',
            count: { $sum: 1 },
            firstDate: { $min: '$date' },
            lastDate: { $max: '$date' },
          },
        },
      ]),

      // Certificates
      Certificate.find({ studentId: student._id, status: 'approved' })
        .populate('submittedBy', 'displayName')
        .populate('approvedBy', 'displayName')
        .populate('issuedBy', 'displayName')
        .sort({ issuedDate: -1 })
        .lean(),

      // Badges
      Badge.find({ studentId: student._id, status: 'approved' })
        .populate('submittedBy', 'displayName')
        .populate('approvedBy', 'displayName')
        .sort({ approvedAt: -1 })
        .lean(),
    ])

    // Monthly class attendance for charting
    const monthlyAttendance = await ClassSession.aggregate([
      { $match: { studentId: student._id, status: { $in: ['completed', 'missed'] }, ...(hasDateFilter ? { date: dateFilter } : {}) } },
      {
        $group: {
          _id: { year: { $year: '$date' }, month: { $month: '$date' } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          missed: { $sum: { $cond: [{ $eq: ['$status', 'missed'] }, 1, 0] } },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      { $limit: 12 },
    ])

    res.json({
      ...student,
      statusHistory,
      relationships,
      familyMembers,
      complaints,
      classStats: classStats[0] || { total: 0, completed: 0, missed: 0, scheduled: 0, started: 0 },
      monthlyAttendance,
      assessments,
      curriculumProgress,
      assignments,
      lessonsByTutor,
      certificates,
      badges,
    })
  } catch (err) {
    console.error('Student detail extended error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function addAdminNote(req, res) {
  try {
    const { text } = req.body
    if (!text?.trim()) return res.status(400).json({ error: 'Note text is required' })

    const student = await Student.findById(req.params.id)
    if (!student) return res.status(404).json({ error: 'Student not found' })

    student.adminNotes.push({ text: text.trim(), createdBy: req.userId })
    await student.save()

    const updated = await Student.findById(student._id)
      .select('adminNotes')
      .populate('adminNotes.createdBy', 'displayName')
      .lean()

    res.status(201).json(updated.adminNotes)
  } catch (err) {
    console.error('Add admin note error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function addStudentFeedback(req, res) {
  try {
    const { type, text } = req.body
    if (!['admin', 'quality'].includes(type)) {
      return res.status(400).json({ error: 'Feedback type must be "admin" or "quality"' })
    }
    if (!text?.trim()) return res.status(400).json({ error: 'Feedback text is required' })

    // Gate by feedback type: admin feedback for super-admins, quality feedback for QC roles
    const needed = type === 'admin' ? 'student.feedback_admin' : 'student.feedback_quality'
    if (!req.userPermissions.has(needed)) {
      return res.status(403).json({ error: 'Insufficient permissions', missing: [needed] })
    }

    const student = await Student.findById(req.params.id)
    if (!student) return res.status(404).json({ error: 'Student not found' })

    student.feedbacks.push({
      type,
      text: text.trim(),
      createdBy: req.userId,
      createdByName: req.user?.displayName || '',
    })
    await student.save()

    await logActivity({
      level: 'info', category: 'student_management', action: 'student_feedback_added',
      message: `${type} feedback added for student ${student.rollNo || student._id}`,
      req, meta: { studentId: student._id, feedbackType: type },
    })

    const updated = await Student.findById(student._id)
      .select('feedbacks')
      .populate('feedbacks.createdBy', 'displayName')
      .lean()

    res.status(201).json(updated.feedbacks)
  } catch (err) {
    console.error('Add student feedback error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteStudentFeedback(req, res) {
  try {
    const { id, feedbackId } = req.params
    const student = await Student.findById(id)
    if (!student) return res.status(404).json({ error: 'Student not found' })

    const fb = student.feedbacks.id(feedbackId)
    if (!fb) return res.status(404).json({ error: 'Feedback not found' })

    // Same gate as creation — must hold the matching feedback permission
    const needed = fb.type === 'admin' ? 'student.feedback_admin' : 'student.feedback_quality'
    if (!req.userPermissions.has(needed)) {
      return res.status(403).json({ error: 'Insufficient permissions', missing: [needed] })
    }

    fb.deleteOne()
    await student.save()

    const updated = await Student.findById(student._id)
      .select('feedbacks')
      .populate('feedbacks.createdBy', 'displayName')
      .lean()

    res.json(updated.feedbacks)
  } catch (err) {
    console.error('Delete student feedback error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function addManualTutorLog(req, res) {
  try {
    const { tutorId, track, startDate, endDate, reason } = req.body
    if (!tutorId || !track || !startDate) {
      return res.status(400).json({ error: 'tutorId, track, and startDate are required' })
    }

    const student = await Student.findById(req.params.id)
    if (!student) return res.status(404).json({ error: 'Student not found' })

    const assignment = await Assignment.create({
      studentId: student._id,
      tutorId,
      track,
      startDate: new Date(startDate),
      endDate: endDate ? new Date(endDate) : null,
      reason: reason || 'Manual entry',
      assignedBy: req.userId,
    })

    await logActivity({
      level: 'info', category: 'assignment', action: 'manual_tutor_log',
      message: `Manual tutor log added for student ${student.rollNo || student._id}`,
      req,
    })

    const populated = await Assignment.findById(assignment._id)
      .populate('tutorId', 'name tutorId')
      .populate('assignedBy', 'displayName')
      .lean()

    res.status(201).json(populated)
  } catch (err) {
    console.error('Add manual tutor log error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

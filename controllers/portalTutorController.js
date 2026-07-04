import TutorProfile from '../models/TutorProfile.js'
import User from '../models/User.js'
import Role from '../models/Role.js'
import Assignment from '../models/Assignment.js'
import TutorAttendance from '../models/TutorAttendance.js'
import ClassSession from '../models/ClassSession.js'
import ClassSlot from '../models/ClassSlot.js'
import LessonEntry from '../models/LessonEntry.js'
import PermanentLesson from '../models/PermanentLesson.js'
import Complaint from '../models/Complaint.js'
import Notice from '../models/Notice.js'
import SalaryRecord from '../models/SalaryRecord.js'
import SalaryIncrement from '../models/SalaryIncrement.js'
import { logActivity } from '../utils/activityLogger.js'

async function generateTutorId() {
  const last = await TutorProfile.findOne({ tutorId: { $regex: /^T\d+$/ } })
    .sort({ tutorId: -1 })
    .select('tutorId')
    .lean()

  if (!last) return 'T01'
  const num = parseInt(last.tutorId.replace('T', ''), 10) + 1
  return `T${String(num).padStart(2, '0')}`
}

export async function listTutors(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { search, status, skillLevel } = req.query

    const filter = {}

    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ name: regex }, { tutorId: regex }, { email: regex }]
    }
    if (status) filter.status = status
    if (skillLevel) filter.skillLevel = skillLevel

    const total = await TutorProfile.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await TutorProfile.find(filter)
      .populate('userId', 'email displayName status mfa.enabled lastLoginAt')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List tutors error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getTutor(req, res) {
  try {
    const tutor = await TutorProfile.findById(req.params.id)
      .populate('userId', 'email displayName status mfa.enabled lastLoginAt')
      .lean()

    if (!tutor) return res.status(404).json({ error: 'Tutor not found' })

    res.json(tutor)
  } catch (err) {
    console.error('Get tutor error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createTutor(req, res) {
  try {
    const { name, email, password, phone, skillLevel, roomNo, meetLink, subjects, notes, salary, shiftWindows } = req.body

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' })
    }

    // Check for existing user
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() })
    if (existingUser) {
      return res.status(400).json({ error: 'A user with this email already exists' })
    }

    // Get tutor role
    const tutorRole = await Role.findOne({ key: 'tutor' })
    if (!tutorRole) {
      return res.status(400).json({ error: 'Tutor role not found. Please seed roles first.' })
    }

    // Create user account
    const user = await User.create({
      email: email.toLowerCase().trim(),
      password,
      displayName: name.trim(),
      phone: phone?.trim() || '',
      roles: [tutorRole._id],
      status: 'active',
      mustLoginWithinShift: true,
    })

    // Generate tutor ID
    const tutorId = await generateTutorId()

    // Create tutor profile
    const tutor = await TutorProfile.create({
      tutorId,
      userId: user._id,
      name: name.trim(),
      phone: phone?.trim() || '',
      email: email.toLowerCase().trim(),
      skillLevel: skillLevel || 'beginner',
      roomNo: roomNo?.trim() || '',
      meetLink: meetLink?.trim() || '',
      subjects: subjects || [],
      notes: notes?.trim() || '',
      salary: salary || { baseAmount: 0, currency: 'PKR' },
      shiftWindows: shiftWindows || [],
    })

    // Link user to tutor profile
    user.linkedTutorId = tutor._id
    await user.save()

    await logActivity({
      level: 'info',
      category: 'tutor_management',
      action: 'tutor_created',
      message: `Tutor created: ${tutor.name} (${tutor.tutorId})`,
      req,
      meta: { tutorId: tutor._id, userId: user._id },
    })

    const populated = await TutorProfile.findById(tutor._id)
      .populate('userId', 'email displayName status mfa.enabled')
      .lean()

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create tutor error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateTutor(req, res) {
  try {
    const tutor = await TutorProfile.findById(req.params.id)
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' })

    const allowedFields = ['name', 'phone', 'skillLevel', 'roomNo', 'meetLink', 'subjects', 'notes', 'status', 'salary', 'shiftWindows']

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        tutor[field] = req.body[field]
      }
    }

    await tutor.save()

    await logActivity({
      level: 'info',
      category: 'tutor_management',
      action: 'tutor_updated',
      message: `Tutor updated: ${tutor.name} (${tutor.tutorId})`,
      req,
      meta: { tutorId: tutor._id },
    })

    const populated = await TutorProfile.findById(tutor._id)
      .populate('userId', 'email displayName status mfa.enabled')
      .lean()

    res.json(populated)
  } catch (err) {
    console.error('Update tutor error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteTutor(req, res) {
  try {
    const tutor = await TutorProfile.findById(req.params.id)
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' })

    // Deactivate user account
    if (tutor.userId) {
      await User.findByIdAndUpdate(tutor.userId, { status: 'suspended' })
    }

    await TutorProfile.findByIdAndDelete(req.params.id)

    await logActivity({
      level: 'warning',
      category: 'tutor_management',
      action: 'tutor_deleted',
      message: `Tutor deleted: ${tutor.name} (${tutor.tutorId})`,
      req,
      meta: { tutorId: tutor._id },
    })

    res.json({ message: 'Tutor deleted' })
  } catch (err) {
    console.error('Delete tutor error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getTutorStats(req, res) {
  try {
    const [total, activeCount, skillStats] = await Promise.all([
      TutorProfile.countDocuments(),
      TutorProfile.countDocuments({ status: 'active' }),
      TutorProfile.aggregate([{ $group: { _id: '$skillLevel', count: { $sum: 1 } } }]),
    ])

    res.json({ total, activeCount, skillStats })
  } catch (err) {
    console.error('Tutor stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getTutorDetailExtended(req, res) {
  try {
    const tutor = await TutorProfile.findById(req.params.id)
      .populate('userId', 'email displayName status mfa.enabled lastLoginAt createdAt')
      .lean()

    if (!tutor) return res.status(404).json({ error: 'Tutor not found' })

    // Date filter support
    const { dateFrom, dateTo } = req.query
    const dateFilter = {}
    if (dateFrom) dateFilter.$gte = new Date(dateFrom)
    if (dateTo) dateFilter.$lte = new Date(dateTo)
    const hasDateFilter = Object.keys(dateFilter).length > 0

    const tutorObjectId = tutor._id

    const [
      assignments,
      activeStudentCount,
      attendanceStats,
      monthlyAttendance,
      recentAttendance,
      classSessionStats,
      monthlyClassSessions,
      lessonsByStudent,
      permanentLessonStats,
      complaints,
      notices,
      salaryRecords,
      salaryIncrements,
      activeSlots,
    ] = await Promise.all([
      // All assignments (student history)
      Assignment.find({ tutorId: tutorObjectId })
        .populate('studentId', 'name rollNo status courseLabels')
        .sort({ startDate: -1 })
        .lean(),

      // Active students count
      Assignment.countDocuments({ tutorId: tutorObjectId, endDate: null }),

      // Attendance aggregate stats
      TutorAttendance.aggregate([
        { $match: { tutorId: tutorObjectId, ...(hasDateFilter ? { date: dateFilter } : {}) } },
        {
          $group: {
            _id: null,
            totalDays: { $sum: 1 },
            present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
            absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
            partial: { $sum: { $cond: [{ $eq: ['$status', 'partial'] }, 1, 0] } },
            totalHours: { $sum: { $ifNull: ['$totalHours', 0] } },
          },
        },
      ]),

      // Monthly attendance (last 12 months)
      TutorAttendance.aggregate([
        {
          $match: {
            tutorId: tutorObjectId,
            date: hasDateFilter ? dateFilter : { $gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
          },
        },
        {
          $group: {
            _id: { year: { $year: '$date' }, month: { $month: '$date' } },
            present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
            absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
            partial: { $sum: { $cond: [{ $eq: ['$status', 'partial'] }, 1, 0] } },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),

      // Recent attendance records (last 30)
      TutorAttendance.find({ tutorId: tutorObjectId, ...(hasDateFilter ? { date: dateFilter } : {}) })
        .sort({ date: -1 })
        .limit(30)
        .lean(),

      // Class session stats
      ClassSession.aggregate([
        { $match: { tutorId: tutorObjectId, ...(hasDateFilter ? { date: dateFilter } : {}) } },
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

      // Monthly class sessions (last 12 months)
      ClassSession.aggregate([
        {
          $match: {
            tutorId: tutorObjectId,
            date: hasDateFilter ? dateFilter : { $gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
          },
        },
        {
          $group: {
            _id: { year: { $year: '$date' }, month: { $month: '$date' } },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $eq: ['$status', 'missed'] }, 1, 0] } },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),

      // Lesson entries grouped by student
      LessonEntry.aggregate([
        { $match: { tutorId: tutorObjectId, ...(hasDateFilter ? { date: dateFilter } : {}) } },
        {
          $group: {
            _id: '$studentId',
            count: { $sum: 1 },
            firstDate: { $min: '$date' },
            lastDate: { $max: '$date' },
          },
        },
        {
          $lookup: {
            from: 'students',
            localField: '_id',
            foreignField: '_id',
            as: 'student',
          },
        },
        { $unwind: { path: '$student', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            count: 1,
            firstDate: 1,
            lastDate: 1,
            studentName: '$student.name',
            studentRollNo: '$student.rollNo',
            studentStatus: '$student.status',
          },
        },
        { $sort: { count: -1 } },
      ]),

      // Permanent lesson stats (submitted, approved, rejected)
      PermanentLesson.aggregate([
        { $match: { tutorId: tutorObjectId } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),

      // Complaints against this tutor
      req.userPermissions.has('complaint.read')
        ? Complaint.find({ againstTutorId: tutorObjectId })
            .populate('studentId', 'name rollNo')
            .populate('createdBy', 'displayName')
            .populate('resolvedBy', 'displayName')
            .sort({ createdAt: -1 })
            .lean()
        : [],

      // Notices targeting this tutor
      req.userPermissions.has('notice.read')
        ? Notice.find({ targetTutorId: tutorObjectId })
            .populate('createdBy', 'displayName')
            .sort({ createdAt: -1 })
            .lean()
        : [],

      // Salary records
      req.userPermissions.has('finance.read')
        ? SalaryRecord.find({ tutorId: tutorObjectId })
            .sort({ year: -1, month: -1 })
            .lean()
        : [],

      // Salary increments
      req.userPermissions.has('finance.read')
        ? SalaryIncrement.find({ tutorId: tutorObjectId })
            .populate('approvedBy', 'displayName')
            .sort({ effectiveDate: -1 })
            .lean()
        : [],

      // Active class slots
      ClassSlot.find({ tutorId: tutorObjectId, active: true })
        .populate('studentId', 'name rollNo status')
        .sort({ dayOfWeek: 1, startTime: 1 })
        .lean(),
    ])

    res.json({
      ...tutor,
      activeStudentCount,
      assignments,
      attendanceStats: attendanceStats[0] || { totalDays: 0, present: 0, absent: 0, partial: 0, totalHours: 0 },
      monthlyAttendance,
      recentAttendance,
      classSessionStats: classSessionStats[0] || { total: 0, completed: 0, missed: 0, scheduled: 0, started: 0 },
      monthlyClassSessions,
      lessonsByStudent,
      permanentLessonStats,
      complaints,
      notices,
      salaryRecords,
      salaryIncrements,
      activeSlots,
    })
  } catch (err) {
    console.error('Get tutor detail error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

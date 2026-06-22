import Student from '../models/Student.js'
import StudentStatusHistory from '../models/StudentStatusHistory.js'
import Family from '../models/Family.js'
import StudentRelationship from '../models/StudentRelationship.js'
import { logActivity } from '../utils/activityLogger.js'

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

export async function getStudent(req, res) {
  try {
    const student = await Student.findById(req.params.id)
      .populate('familyId')
      .populate('userId', 'email displayName status')
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

export async function createStudent(req, res) {
  try {
    const data = req.body

    if (!data.name) {
      return res.status(400).json({ error: 'Student name is required' })
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

    // Create initial status history
    await StudentStatusHistory.create({
      studentId: student._id,
      status: student.status,
      effectiveDate: new Date(),
      comment: 'Student created',
      changedBy: req.userId,
    })

    await logActivity({
      level: 'info',
      category: 'student_management',
      action: 'student_created',
      message: `Student created: ${student.name} (${student.rollNo})`,
      req,
      meta: { studentId: student._id },
    })

    res.status(201).json(student)
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

    // Update fields
    const allowedFields = [
      'name', 'parentsName', 'dob', 'country', 'timezone',
      'guardians', 'whatsappNumber', 'courseLabels', 'placementLevel',
      'sect', 'specialNeeds', 'familyId', 'referredBy', 'billing',
      'status', 'email', 'phone', 'notes', 'userId',
    ]

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        student[field] = data[field]
      }
    }

    await student.save()

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

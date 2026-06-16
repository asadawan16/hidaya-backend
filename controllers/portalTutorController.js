import TutorProfile from '../models/TutorProfile.js'
import User from '../models/User.js'
import Role from '../models/Role.js'
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

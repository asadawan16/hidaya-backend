import Assignment from '../models/Assignment.js'
import Student from '../models/Student.js'
import TutorProfile from '../models/TutorProfile.js'
import { logActivity } from '../utils/activityLogger.js'

export async function listAssignments(req, res) {
  try {
    const { studentId, tutorId, track, active } = req.query
    const filter = {}
    if (studentId) filter.studentId = studentId
    if (tutorId) filter.tutorId = tutorId
    if (track) filter.track = track
    if (active === 'true') filter.endDate = null
    if (active === 'false') filter.endDate = { $ne: null }

    const records = await Assignment.find(filter)
      .populate('studentId', 'name rollNo status')
      .populate('tutorId', 'name tutorId skillLevel')
      .populate('assignedBy', 'displayName email')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean()

    res.json(records)
  } catch (err) {
    console.error('List assignments error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createAssignment(req, res) {
  try {
    const { studentId, tutorId, track, reason } = req.body
    if (!studentId || !tutorId || !track) {
      return res.status(400).json({ error: 'studentId, tutorId, and track are required' })
    }

    const student = await Student.findById(studentId)
    if (!student) return res.status(404).json({ error: 'Student not found' })

    const tutor = await TutorProfile.findById(tutorId)
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' })

    // Close any current assignment for this student+track
    await Assignment.updateMany(
      { studentId, track, endDate: null },
      { endDate: new Date() }
    )

    const assignment = await Assignment.create({
      studentId,
      tutorId,
      track,
      startDate: new Date(),
      reason: reason || '',
      assignedBy: req.userId,
    })

    await logActivity({
      level: 'info',
      category: 'assignment',
      action: 'assignment_created',
      message: `${student.rollNo} assigned to ${tutor.tutorId} for ${track}`,
      req,
      meta: { assignmentId: assignment._id },
    })

    const populated = await Assignment.findById(assignment._id)
      .populate('studentId', 'name rollNo')
      .populate('tutorId', 'name tutorId')
      .populate('assignedBy', 'displayName')
      .lean()

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create assignment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function endAssignment(req, res) {
  try {
    const assignment = await Assignment.findById(req.params.id)
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' })
    if (assignment.endDate) return res.status(400).json({ error: 'Assignment already ended' })

    assignment.endDate = new Date()
    assignment.reason = req.body.reason || assignment.reason
    await assignment.save()

    await logActivity({
      level: 'info',
      category: 'assignment',
      action: 'assignment_ended',
      message: `Assignment ${assignment._id} ended`,
      req,
      meta: { assignmentId: assignment._id },
    })

    res.json({ message: 'Assignment ended', assignment })
  } catch (err) {
    console.error('End assignment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getStudentAssignments(req, res) {
  try {
    const records = await Assignment.find({ studentId: req.params.studentId })
      .populate('tutorId', 'name tutorId skillLevel')
      .populate('assignedBy', 'displayName')
      .sort({ createdAt: -1 })
      .lean()

    res.json(records)
  } catch (err) {
    console.error('Get student assignments error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

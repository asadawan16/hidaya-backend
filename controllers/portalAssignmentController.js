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
    const { studentId, tutorId, track, reason, type, endDate: tempEndDate } = req.body
    if (!studentId || !tutorId || !track) {
      return res.status(400).json({ error: 'studentId, tutorId, and track are required' })
    }

    const student = await Student.findById(studentId)
    if (!student) return res.status(404).json({ error: 'Student not found' })

    const tutor = await TutorProfile.findById(tutorId)
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' })

    const assignmentType = type || 'permanent'
    let replacesId = null

    if (assignmentType === 'temporary') {
      // Temporary: don't close the permanent assignment, just add a temporary one alongside
      // Find the current permanent assignment to reference
      const currentPermanent = await Assignment.findOne({ studentId, track, endDate: null, type: 'permanent' })
      if (currentPermanent) replacesId = currentPermanent._id

      if (!tempEndDate) {
        return res.status(400).json({ error: 'endDate is required for temporary assignments' })
      }
    } else {
      // Permanent: close any current assignment (permanent or temporary) for this student+track
      await Assignment.updateMany(
        { studentId, track, endDate: null },
        { endDate: new Date(), reason: reason ? `Replaced: ${reason}` : 'Replaced by new tutor' }
      )
    }

    const assignment = await Assignment.create({
      studentId,
      tutorId,
      track,
      type: assignmentType,
      startDate: new Date(),
      endDate: assignmentType === 'temporary' && tempEndDate ? new Date(tempEndDate) : null,
      reason: reason || '',
      replacesAssignmentId: replacesId || undefined,
      assignedBy: req.userId,
    })

    const actionLabel = assignmentType === 'temporary' ? 'temporarily assigned' : 'assigned'
    await logActivity({
      level: 'info',
      category: 'assignment',
      action: 'assignment_created',
      message: `${student.rollNo} ${actionLabel} to ${tutor.tutorId} for ${track}`,
      req,
      meta: { assignmentId: assignment._id, type: assignmentType },
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

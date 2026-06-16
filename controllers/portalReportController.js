import Student from '../models/Student.js'
import PermanentLesson from '../models/PermanentLesson.js'
import Assessment from '../models/Assessment.js'
import TutorAttendance from '../models/TutorAttendance.js'
import LessonEntry from '../models/LessonEntry.js'
import Assignment from '../models/Assignment.js'

export async function getStudentReport(req, res) {
  try {
    const { studentId } = req.params

    const student = await Student.findById(studentId)
      .populate('familyId', 'familyCode')
      .lean()
    if (!student) return res.status(404).json({ error: 'Student not found' })

    // Progress (approved permanent lessons)
    const progress = await PermanentLesson.find({ studentId, status: 'approved' })
      .populate('curriculumItemId', 'label track type order')
      .populate('tutorId', 'name tutorId')
      .sort({ completedDate: 1 })
      .lean()

    // Assessments
    const assessments = await Assessment.find({ studentId })
      .populate('templateId', 'name')
      .populate('testTeacherId', 'name tutorId')
      .sort({ date: -1 })
      .lean()

    // Recent lessons
    const recentLessons = await LessonEntry.find({ studentId })
      .populate('items.curriculumItemId', 'label track')
      .populate('tutorId', 'name tutorId')
      .sort({ date: -1 })
      .limit(30)
      .lean()

    // Assignment history
    const assignments = await Assignment.find({ studentId })
      .populate('tutorId', 'name tutorId')
      .sort({ startDate: -1 })
      .lean()

    // Group progress by track
    const progressByTrack = {}
    for (const p of progress) {
      const track = p.curriculumItemId?.track || 'unknown'
      if (!progressByTrack[track]) progressByTrack[track] = []
      progressByTrack[track].push(p)
    }

    res.json({
      student,
      progress: { total: progress.length, byTrack: progressByTrack, items: progress },
      assessments,
      recentLessons,
      assignments,
    })
  } catch (err) {
    console.error('Student report error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getBulkReportData(req, res) {
  try {
    const { studentIds } = req.body
    if (!studentIds?.length) return res.status(400).json({ error: 'studentIds array is required' })
    if (studentIds.length > 200) return res.status(400).json({ error: 'Maximum 200 students per bulk report' })

    const students = await Student.find({ _id: { $in: studentIds } }).lean()

    // Batch all counts in aggregations instead of N+1
    const [progressCounts, lessonCounts, lastAssessments, currentAssignments] = await Promise.all([
      PermanentLesson.aggregate([
        { $match: { studentId: { $in: students.map(s => s._id) }, status: 'approved' } },
        { $group: { _id: '$studentId', count: { $sum: 1 } } },
      ]),
      LessonEntry.aggregate([
        { $match: { studentId: { $in: students.map(s => s._id) } } },
        { $group: { _id: '$studentId', count: { $sum: 1 } } },
      ]),
      Assessment.aggregate([
        { $match: { studentId: { $in: students.map(s => s._id) } } },
        { $sort: { date: -1 } },
        { $group: { _id: '$studentId', lastDate: { $first: '$date' }, score: { $first: '$overallScore' }, templateId: { $first: '$templateId' } } },
      ]),
      Assignment.find({ studentId: { $in: studentIds }, endDate: null })
        .populate('tutorId', 'name tutorId')
        .lean(),
    ])

    const progressMap = {}; progressCounts.forEach(p => { progressMap[p._id.toString()] = p.count })
    const lessonMap = {}; lessonCounts.forEach(l => { lessonMap[l._id.toString()] = l.count })
    const assessmentMap = {}; lastAssessments.forEach(a => { assessmentMap[a._id.toString()] = a })
    const assignmentMap = {}; currentAssignments.forEach(a => { assignmentMap[a.studentId.toString()] = a.tutorId })

    const reports = students.map(student => {
      const sid = student._id.toString()
      return {
        student,
        progressCount: progressMap[sid] || 0,
        lessonCount: lessonMap[sid] || 0,
        lastAssessment: assessmentMap[sid] || null,
        currentTutor: assignmentMap[sid] || null,
      }
    })

    res.json(reports)
  } catch (err) {
    console.error('Bulk report error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getTutorPerformance(req, res) {
  try {
    const { tutorId, month, year } = req.query
    if (!tutorId || !month || !year) {
      return res.status(400).json({ error: 'tutorId, month, and year are required' })
    }

    const startDate = new Date(year, month - 1, 1)
    const endDate = new Date(year, month, 0, 23, 59, 59)

    const attendance = await TutorAttendance.find({
      tutorId, date: { $gte: startDate, $lte: endDate },
    }).sort({ date: 1 }).lean()

    const lessonsLogged = await LessonEntry.countDocuments({
      tutorId, date: { $gte: startDate, $lte: endDate },
    })

    const permanentSubmitted = await PermanentLesson.countDocuments({
      tutorId, createdAt: { $gte: startDate, $lte: endDate },
    })

    const permanentApproved = await PermanentLesson.countDocuments({
      tutorId, status: 'approved', approvedAt: { $gte: startDate, $lte: endDate },
    })

    const assignedStudents = await Assignment.find({ tutorId, endDate: null })
      .populate('studentId', 'name rollNo')
      .lean()

    res.json({
      attendance,
      presentDays: attendance.filter(a => a.status === 'present').length,
      absentDays: attendance.filter(a => a.status === 'absent').length,
      totalHours: attendance.reduce((sum, a) => sum + (a.totalHours || 0), 0),
      lessonsLogged,
      permanentSubmitted,
      permanentApproved,
      assignedStudents,
    })
  } catch (err) {
    console.error('Tutor performance error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Student Progress — read-only aggregated education view for staff & tutors.
// Distinct from the student's own /my-progress: this is the staff-facing page
// that lists students and shows one student's curriculum pacing (with overdue
// red flags), recent classes/absences, complaints, assessments, and awards.
// Deliberately EXCLUDES all billing/fee data — this is an education view only.

import Student from '../models/Student.js'
import Assignment from '../models/Assignment.js'
import ClassSession from '../models/ClassSession.js'
import PermanentLesson from '../models/PermanentLesson.js'
import CurriculumItem from '../models/CurriculumItem.js'
import Assessment from '../models/Assessment.js'
import Badge from '../models/Badge.js'
import Certificate from '../models/Certificate.js'
import Complaint from '../models/Complaint.js'
import LessonEntry from '../models/LessonEntry.js'

// Build a short human summary of what was taught in a daily lesson entry.
function summarizeLesson(lesson) {
  if (!lesson) return ''
  if (lesson.customText?.trim()) return lesson.customText.trim()
  const parts = (lesson.items || []).map(it => {
    const label = it.curriculumItemId?.label || ''
    const range = []
    if (it.fromPage || it.toPage) range.push(`p${it.fromPage || '?'}${it.toPage && it.toPage !== it.fromPage ? `–${it.toPage}` : ''}`)
    if (it.ayah) range.push(`ayah ${it.ayah}`)
    const tag = it.portion ? ` (${it.portion})` : ''
    return `${label}${range.length ? ' ' + range.join(', ') : ''}${tag}`.trim()
  }).filter(Boolean)
  return parts.join(' · ')
}

// Fetch daily-lesson summaries for a set of sessions, keyed by sessionId string.
async function lessonsBySession(studentId, sessionIds) {
  if (!sessionIds.length) return {}
  const lessons = await LessonEntry.find({ studentId, sessionId: { $in: sessionIds } })
    .populate('items.curriculumItemId', 'label track')
    .lean()
  const map = {}
  for (const l of lessons) {
    if (l.sessionId) map[l.sessionId.toString()] = { _id: l._id, taught: summarizeLesson(l), notes: l.notes || '', kind: l.kind }
  }
  return map
}

// Family relations that mark a complaint as "parent-initiated" (mirrors the
// classifier used in the student-detail ComplaintsTab).
const PARENT_RELATIONS = ['father', 'mother', 'grandfather', 'grandmother', 'uncle', 'aunty', 'brother', 'sister']

// Loose map from a student's courseLabels to curriculum tracks, so overdue
// flagging only applies to tracks the student is actually enrolled in.
const COURSE_TRACK_MAP = {
  qaida: ['qaida'],
  nazra: ['quran'],
  hifz: ['hifz'],
  tafseer: ['tafseer'],
  tajweed: ['quran'],
  translation: ['quran'],
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Resolve the set of student ids the requester may view. Returns null for
// "all students". Progress is now visible to everyone who holds
// `student_progress.read` (management AND tutors) — tutors are no longer
// scoped to only their assigned students, so oversight and cross-cover work.
// The route-level `student_progress.read` gate is the access boundary.
async function resolveScope(user) { // eslint-disable-line no-unused-vars
  return null
}

// GET /portal/student-progress  — paginated list of students (scoped for tutors)
export async function listProgressStudents(req, res) {
  try {
    const scope = await resolveScope(req.user)

    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const { search, status } = req.query

    const filter = {}
    if (Array.isArray(scope)) {
      if (scope.length === 0) return res.json({ records: [], total: 0, page: 1, pages: 1 })
      filter._id = { $in: scope }
    }
    if (status) filter.status = status
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ name: rx }, { rollNo: rx }]
    }

    const total = await Student.countDocuments(filter)
    const records = await Student.find(filter)
      .select('name rollNo status courseLabels placementLevel performanceFlag joiningDate country')
      .sort({ name: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()

    // Attach current tutor name(s) for each student in the page
    const ids = records.map(s => s._id)
    const activeAssignments = await Assignment.find({ studentId: { $in: ids }, endDate: null })
      .populate('tutorId', 'name tutorId')
      .select('studentId tutorId track')
      .lean()
    const tutorsByStudent = {}
    for (const a of activeAssignments) {
      const key = a.studentId.toString()
      if (!tutorsByStudent[key]) tutorsByStudent[key] = []
      if (a.tutorId?.name) tutorsByStudent[key].push(a.tutorId.name)
    }

    const enriched = records.map(s => ({
      ...s,
      tutorNames: [...new Set(tutorsByStudent[s._id.toString()] || [])],
    }))

    res.json({ records: enriched, total, page, pages: Math.max(1, Math.ceil(total / limit)) })
  } catch (err) {
    console.error('List progress students error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/student-progress/:id  — full education progress for one student
export async function getStudentProgressDetail(req, res) {
  try {
    const scope = await resolveScope(req.user)
    const studentId = req.params.id

    if (Array.isArray(scope) && !scope.some(id => id.toString() === studentId)) {
      return res.status(403).json({ error: 'You do not have access to this student' })
    }

    const student = await Student.findById(studentId)
      .select('name rollNo status courseLabels placementLevel performanceFlag performanceTags freshness leaveStartDate expectedResumeDate sect specialNeeds guardians dob joiningDate country timezone whatsappNumber feedbacks')
      .populate('feedbacks.createdBy', 'displayName')
      .lean()
    if (!student) return res.status(404).json({ error: 'Student not found' })

    const startRef = student.joiningDate ? new Date(student.joiningDate) : new Date(student.createdAt || Date.now())
    const now = new Date()

    const [items, approved, recentSessions, classStats, assessments, badges, certificates, complaintsRaw, assignments] = await Promise.all([
      CurriculumItem.find({ active: { $ne: false } })
        .select('track type label order expectedDays meta')
        .sort({ track: 1, order: 1 })
        .lean(),

      PermanentLesson.find({ studentId, status: 'approved' })
        .populate('tutorId', 'name tutorId')
        .select('curriculumItemId completedDate tutorId')
        .lean(),

      ClassSession.find({ studentId })
        .sort({ date: -1, scheduledStart: -1 })
        .limit(10)
        .populate('tutorId', 'name tutorId')
        .populate('slotId', 'track')
        .lean(),

      ClassSession.aggregate([
        { $match: { studentId: student._id } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $eq: ['$status', 'missed'] }, 1, 0] } },
            late: { $sum: { $cond: [{ $eq: ['$attendance', 'late'] }, 1, 0] } },
          },
        },
      ]),

      Assessment.find({ studentId })
        .populate('templateId', 'name')
        .populate('testTeacherId', 'name tutorId')
        .sort({ date: -1 })
        .limit(20)
        .lean(),

      Badge.find({ studentId, status: 'approved' }).sort({ approvedAt: -1 }).lean(),

      Certificate.find({ studentId, status: 'approved' }).sort({ issuedDate: -1 }).lean(),

      Complaint.find({ studentId })
        .populate('againstTutorId', 'name tutorId')
        .populate('createdBy', 'displayName')
        .sort({ createdAt: -1 })
        .lean(),

      Assignment.find({ studentId, endDate: null })
        .populate('tutorId', 'name tutorId')
        .select('tutorId track type startDate')
        .lean(),
    ])

    // ── Completed lookup ──
    const completedMap = {}
    for (const pl of approved) {
      if (pl.curriculumItemId) {
        completedMap[pl.curriculumItemId.toString()] = {
          completedDate: pl.completedDate,
          tutorName: pl.tutorId?.name || '',
        }
      }
    }

    // ── Which tracks is the student enrolled in? (drives overdue flagging) ──
    const enrolledTracks = new Set()
    for (const label of student.courseLabels || []) {
      for (const t of (COURSE_TRACK_MAP[label] || [])) enrolledTracks.add(t)
    }
    // (Tracks with existing progress are also treated as enrolled — added below
    // once items are grouped by track.)

    // ── Build curriculum by track with cumulative overdue flags ──
    const byTrackMap = {}
    for (const it of items) {
      if (!byTrackMap[it.track]) byTrackMap[it.track] = []
      byTrackMap[it.track].push(it)
    }

    // A track counts as "started" (hence enrolled) if any of its items are done.
    for (const track of Object.keys(byTrackMap)) {
      if (byTrackMap[track].some(it => completedMap[it._id.toString()])) enrolledTracks.add(track)
    }

    const curriculum = Object.keys(byTrackMap).map(track => {
      const trackItems = byTrackMap[track]
      const tracked = enrolledTracks.has(track)
      let cumulativeDays = 0
      let completedCount = 0
      let overdueCount = 0

      const outItems = trackItems.map(it => {
        const done = completedMap[it._id.toString()]
        cumulativeDays += Math.max(0, it.expectedDays || 0)
        const dueDate = it.expectedDays > 0 ? new Date(startRef.getTime() + cumulativeDays * MS_PER_DAY) : null
        const overdue = tracked && !done && it.expectedDays > 0 && dueDate && now > dueDate
        if (done) completedCount++
        if (overdue) overdueCount++
        return {
          _id: it._id,
          label: it.label,
          type: it.type,
          order: it.order,
          expectedDays: it.expectedDays || 0,
          completed: !!done,
          completedDate: done?.completedDate || null,
          tutorName: done?.tutorName || '',
          dueDate,
          overdue,
        }
      })

      return {
        track,
        enrolled: tracked,
        total: trackItems.length,
        completed: completedCount,
        overdueCount,
        items: outItems,
      }
    })

    // ── Complaints: split management-initiated vs parent-initiated ──
    const complaints = complaintsRaw.map(c => ({
      _id: c._id,
      date: c.date,
      text: c.text,
      status: c.status,
      priority: c.priority,
      category: c.category,
      complainant: c.complainant,
      representative: c.representative,
      againstTutor: c.againstTutorId ? { name: c.againstTutorId.name, tutorId: c.againstTutorId.tutorId } : null,
      createdBy: c.createdBy?.displayName || '',
      actionRequired: c.actionRequired || '',
      createdAt: c.createdAt,
    }))
    const parentComplaints = complaints.filter(c => PARENT_RELATIONS.includes(c.complainant))
    const managementComplaints = complaints.filter(c =>
      c.complainant === 'other' || c.complainant === 'student' ||
      c.category === 'admin_feedback' || c.category === 'quality_issue'
    )

    const stats = classStats[0] || { total: 0, completed: 0, missed: 0, late: 0 }
    const totalItems = curriculum.reduce((s, t) => s + t.total, 0)
    const totalCompleted = curriculum.reduce((s, t) => s + t.completed, 0)
    const totalOverdue = curriculum.reduce((s, t) => s + t.overdueCount, 0)

    // Attach the daily-lesson "what was taught" to each recent class
    const lessonMap = await lessonsBySession(studentId, recentSessions.map(s => s._id))

    // Split feedbacks by type for the progress page (populated author)
    const feedbacks = (student.feedbacks || [])
      .map(f => ({
        _id: f._id,
        type: f.type,
        text: f.text,
        author: f.createdBy?.displayName || f.createdByName || '',
        createdAt: f.createdAt,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

    res.json({
      student,
      currentTutors: assignments.map(a => ({
        name: a.tutorId?.name || '',
        tutorId: a.tutorId?.tutorId || '',
        track: a.track,
        type: a.type,
        since: a.startDate,
      })),
      summary: {
        totalItems,
        totalCompleted,
        totalOverdue,
        percent: totalItems ? Math.round((totalCompleted / totalItems) * 100) : 0,
        classesTotal: stats.total,
        classesCompleted: stats.completed,
        absences: stats.missed,
        lateCount: stats.late,
      },
      curriculum,
      recentClasses: recentSessions.map(s => {
        const lesson = lessonMap[s._id.toString()]
        return {
          _id: s._id,
          date: s.date,
          scheduledStart: s.scheduledStart,
          status: s.status,
          attendance: s.attendance,
          computedDuration: s.computedDuration,
          track: s.slotId?.track || '',
          tutorName: s.tutorId?.name || '',
          taught: lesson?.taught || '',
          lessonNotes: lesson?.notes || '',
          lessonKind: lesson?.kind || '',
        }
      }),
      feedbacks,
      assessments: assessments.map(a => ({
        _id: a._id,
        date: a.date,
        scope: a.scope,
        overallScore: a.overallScore,
        attendance: a.attendance,
        templateName: a.templateId?.name || '',
        testTeacher: a.testTeacherId?.name || '',
      })),
      badges,
      certificates,
      parentComplaints,
      managementComplaints,
    })
  } catch (err) {
    console.error('Student progress detail error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/student-progress/:id/classes — paginated class history with daily
// lessons attached. Powers the "View more" expansion on the recent-classes card.
export async function getStudentClasses(req, res) {
  try {
    const scope = await resolveScope(req.user)
    const studentId = req.params.id

    if (Array.isArray(scope) && !scope.some(id => id.toString() === studentId)) {
      return res.status(403).json({ error: 'You do not have access to this student' })
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20))

    const filter = { studentId }
    const total = await ClassSession.countDocuments(filter)
    const sessions = await ClassSession.find(filter)
      .sort({ date: -1, scheduledStart: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('tutorId', 'name tutorId')
      .populate('slotId', 'track')
      .lean()

    const lessonMap = await lessonsBySession(studentId, sessions.map(s => s._id))

    const records = sessions.map(s => {
      const lesson = lessonMap[s._id.toString()]
      return {
        _id: s._id,
        date: s.date,
        scheduledStart: s.scheduledStart,
        status: s.status,
        attendance: s.attendance,
        computedDuration: s.computedDuration,
        track: s.slotId?.track || '',
        tutorName: s.tutorId?.name || '',
        taught: lesson?.taught || '',
        lessonNotes: lesson?.notes || '',
        lessonKind: lesson?.kind || '',
      }
    })

    res.json({ records, total, page, pages: Math.max(1, Math.ceil(total / limit)) })
  } catch (err) {
    console.error('Student classes error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/student-progress/:id/lessons — paginated daily-lesson history for a
// student. Powers the "Recent Lessons" section so tutors can review lessons from the
// progress page instead of the (optionally hidden) lessons list. Gated by
// student_progress.read — independent of the lesson.* permissions.
export async function getStudentLessons(req, res) {
  try {
    const scope = await resolveScope(req.user)
    const studentId = req.params.id

    if (Array.isArray(scope) && !scope.some(id => id.toString() === studentId)) {
      return res.status(403).json({ error: 'You do not have access to this student' })
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10))

    const filter = { studentId }
    const total = await LessonEntry.countDocuments(filter)
    const lessons = await LessonEntry.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('tutorId', 'name tutorId')
      .populate('items.curriculumItemId', 'label track')
      .lean()

    const records = lessons.map(l => ({
      _id: l._id,
      date: l.date,
      kind: l.kind,
      classStart: l.classStart || '',
      classEnd: l.classEnd || '',
      taught: summarizeLesson(l),
      notes: l.notes || '',
      tutorName: l.tutorId?.name || '',
      track: l.items?.[0]?.curriculumItemId?.track || '',
    }))

    res.json({ records, total, page, pages: Math.max(1, Math.ceil(total / limit)) })
  } catch (err) {
    console.error('Student lessons error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

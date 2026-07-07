// Smoke test for the Student Progress feature.
// Creates temp curriculum/student/lesson data, exercises the controller with
// mocked req/res (management + tutor scope), asserts the overdue red-flag logic,
// then cleans up. Run: node scripts/smoke-student-progress.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import Student from '../models/Student.js'
import CurriculumItem from '../models/CurriculumItem.js'
import PermanentLesson from '../models/PermanentLesson.js'
import TutorProfile from '../models/TutorProfile.js'
import { listProgressStudents, getStudentProgressDetail } from '../controllers/portalStudentProgressController.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }

function mockRes() {
  const res = { _status: 200, _json: null }
  res.status = (c) => { res._status = c; return res }
  res.json = (d) => { res._json = d; return res }
  return res
}
const mgmtReq = (params = {}, query = {}) => ({
  user: { roles: [{ key: 'admin' }], linkedTutorId: null },
  userPermissions: new Set(['student_progress.read', 'complaint.read']),
  params, query,
})

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
  console.log('Connected. Setting up temp data…')

  const tutor = await TutorProfile.findOne().lean()
  if (!tutor) throw new Error('No tutor profile in DB to attach a permanent lesson to')

  const daysAgo = (n) => new Date(Date.now() - n * 86400000)

  const item = await CurriculumItem.create({
    track: 'qaida', type: 'page', label: 'SMOKE Overdue Page', order: 99999, expectedDays: 2, active: true,
  })
  const student = await Student.create({
    name: 'SMOKE Progress Student', rollNo: 'SMOKE-PROG-1', courseLabels: ['qaida'],
    joiningDate: daysAgo(100), status: 'active',
  })

  try {
    // 1) Detail — item should be OVERDUE (expectedDays 2, joined 100d ago, not completed)
    let res = mockRes()
    await getStudentProgressDetail(mgmtReq({ id: String(student._id) }), res)
    ok(res._status === 200, 'detail returns 200')
    const qaida = (res._json?.curriculum || []).find(t => t.track === 'qaida')
    const smokeItem = qaida?.items.find(i => String(i._id) === String(item._id))
    ok(!!smokeItem, 'temp curriculum item present in qaida track')
    ok(smokeItem?.overdue === true, 'uncompleted item past cumulative deadline is flagged overdue (red)')
    ok(res._json.summary.totalOverdue >= 1, 'summary.totalOverdue >= 1')
    ok(res._json.student.billing === undefined, 'no billing data leaked into progress view')
    ok(Array.isArray(res._json.recentClasses), 'recentClasses array present')
    ok(Array.isArray(res._json.managementComplaints) && Array.isArray(res._json.parentComplaints), 'complaints split present')

    // 2) Complete it → should no longer be overdue
    const pl = await PermanentLesson.create({
      studentId: student._id, tutorId: tutor._id, curriculumItemId: item._id,
      status: 'approved', completedDate: daysAgo(1),
    })
    res = mockRes()
    await getStudentProgressDetail(mgmtReq({ id: String(student._id) }), res)
    const qaida2 = (res._json?.curriculum || []).find(t => t.track === 'qaida')
    const smokeItem2 = qaida2?.items.find(i => String(i._id) === String(item._id))
    ok(smokeItem2?.completed === true, 'approved permanent lesson marks item completed')
    ok(smokeItem2?.overdue === false, 'completed item is NOT overdue')

    // 3) List (management) includes the temp student
    res = mockRes()
    await listProgressStudents(mgmtReq({}, { search: 'SMOKE Progress', limit: 50 }), res)
    ok(res._status === 200 && res._json.records.some(r => String(r._id) === String(student._id)), 'management list includes temp student')

    // 4) Tutor scope — a tutor with no assignment to this student is blocked
    const tutorReq = {
      user: { roles: [{ key: 'tutor' }], linkedTutorId: new mongoose.Types.ObjectId() },
      userPermissions: new Set(['student_progress.read']),
      params: { id: String(student._id) }, query: {},
    }
    res = mockRes()
    await getStudentProgressDetail(tutorReq, res)
    ok(res._status === 403, 'unassigned tutor is denied access to student detail (403)')
    res = mockRes()
    await listProgressStudents({ ...tutorReq, params: {}, query: {} }, res)
    ok(res._status === 200 && !res._json.records.some(r => String(r._id) === String(student._id)), 'unassigned tutor list excludes the student')
  } finally {
    // Cleanup
    await PermanentLesson.deleteMany({ studentId: student._id })
    await Student.deleteOne({ _id: student._id })
    await CurriculumItem.deleteOne({ _id: item._id })
    console.log('Cleaned up temp data.')
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  await mongoose.disconnect()
  process.exit(fail ? 1 : 0)
}

run().catch(e => { console.error('SMOKE ERROR:', e); process.exit(1) })

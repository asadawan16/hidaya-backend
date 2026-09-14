// Smoke test for per-student class links — the "Student Links" tab of
// /portal/class-links and the public page at /my-class/:token.
// Connects straight to Mongo (no running server needed) and drives the real
// controllers with mock req/res objects, then cleans up everything it created.
//
//   node scripts/smoke-student-class-links.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import Student from '../models/Student.js'
import StudentClassLink from '../models/StudentClassLink.js'
import {
  listStudentClassLinks, upsertStudentClassLink, updateStudentClassLink,
  deleteStudentClassLink, bulkAssignStudentClassLinks, bulkDeleteStudentClassLinks,
} from '../controllers/portalStudentClassLinkController.js'
import {
  getPublicStudentClassLink, trackStudentClassLinkClick,
} from '../controllers/publicClassLinkController.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const mockRes = () => {
  const res = { statusCode: 200, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  return res
}
const call = async (handler, req = {}) => {
  const res = mockRes()
  await handler({ query: {}, params: {}, body: {}, userPermissions: new Set(), ...req }, res)
  return res
}

await mongoose.connect(process.env.MONGODB_URI)
console.log('Connected.\n')

const students = await Student.find().select('name rollNo').limit(3).lean()
if (students.length < 3) {
  console.error('Need at least 3 students — seed first (node seedClientDemo.js).')
  await mongoose.disconnect()
  process.exit(1)
}
const [alpha, beta, gamma] = students
const touched = students.map(s => s._id)

// The run must not disturb links that already exist for these students.
const preExisting = await StudentClassLink.find({ student: { $in: touched } }).lean()
if (preExisting.length) {
  console.error(`Students ${preExisting.map(l => l.studentName).join(', ')} already have links — pick a cleaner DB.`)
  await mongoose.disconnect()
  process.exit(1)
}

try {
  // ── create ────────────────────────────────────────────────────────────────
  const created = await call(upsertStudentClassLink, {
    body: {
      studentId: String(alpha._id),
      url: 'meet.google.com/smoke-aaa-bbb',   // no scheme on purpose
      tutorName: 'Smoke Tutor',
      label: 'Hifz — Evening',
      platform: 'google_meet',
      timing: 'Mon–Fri · 8:00 PM',
      note: 'Bring your Qaida.',
      theme: 3,
    },
  })
  check('create returns 201', created.statusCode === 201, `got ${created.statusCode}`)
  check('url gets https:// prefixed', created.body?.url === 'https://meet.google.com/smoke-aaa-bbb', created.body?.url)
  check('token minted', typeof created.body?.token === 'string' && created.body.token.length >= 10)
  check('name snapshotted', created.body?.studentName === alpha.name)

  const token = created.body.token

  // ── public page ───────────────────────────────────────────────────────────
  const pub = await call(getPublicStudentClassLink, { params: { token } })
  check('public page found + active', pub.body?.found === true && pub.body?.active === true)
  check('public greets by first name', pub.body?.firstName === alpha.name.split(/\s+/)[0], pub.body?.firstName)
  check('public carries the chosen theme', pub.body?.theme === 3, String(pub.body?.theme))
  check('public leaks no student id', !('studentId' in (pub.body || {})) && !('rollNo' in (pub.body || {})))

  const missing = await call(getPublicStudentClassLink, { params: { token: 'not-a-real-token' } })
  check('unknown token → found:false, not an error', missing.statusCode === 200 && missing.body?.found === false)

  // ── click counter ─────────────────────────────────────────────────────────
  await call(trackStudentClassLinkClick, { params: { token } })
  await call(trackStudentClassLinkClick, { params: { token } })
  const clicked = await StudentClassLink.findOne({ token }).lean()
  check('clicks increment', clicked.clicks === 2, String(clicked.clicks))
  check('lastClickedAt stamped', Boolean(clicked.lastClickedAt))

  // ── upsert again = update, same token ─────────────────────────────────────
  const updated = await call(upsertStudentClassLink, {
    body: { studentId: String(alpha._id), url: 'https://zoom.us/j/smoke', platform: 'zoom' },
  })
  check('second save returns 200 (update, not create)', updated.statusCode === 200, `got ${updated.statusCode}`)
  check('token is stable across updates', updated.body?.token === token)
  check('url replaced', updated.body?.url === 'https://zoom.us/j/smoke')
  check('one link per student', await StudentClassLink.countDocuments({ student: alpha._id }) === 1)

  // ── list: student-first, with the link attached ───────────────────────────
  const listed = await call(listStudentClassLinks, { query: { search: alpha.name, limit: '50' } })
  const alphaRow = (listed.body?.records || []).find(r => String(r._id) === String(alpha._id))
  check('list returns the student', Boolean(alphaRow))
  check('list hangs the link off the row', alphaRow?.classLink?.token === token)
  check('list summary counts links', (listed.body?.summary?.linked ?? 0) >= 1)

  const onlyLinked = await call(listStudentClassLinks, { query: { linked: 'yes', limit: '100' } })
  check('linked=yes includes the student',
    (onlyLinked.body?.records || []).some(r => String(r._id) === String(alpha._id)))
  check('linked=yes rows all have a link',
    (onlyLinked.body?.records || []).every(r => r.classLink))

  const onlyUnlinked = await call(listStudentClassLinks, { query: { linked: 'no', limit: '100' } })
  check('linked=no excludes the student',
    !(onlyUnlinked.body?.records || []).some(r => String(r._id) === String(alpha._id)))

  // ── pause hides the page without deleting it ──────────────────────────────
  await call(updateStudentClassLink, {
    params: { id: String(created.body._id) },
    body: { isActive: false },
  })
  const paused = await call(getPublicStudentClassLink, { params: { token } })
  check('paused page: found but not active', paused.body?.found === true && paused.body?.active === false)
  check('paused page hides the url', !('url' in (paused.body || {})))
  await call(updateStudentClassLink, { params: { id: String(created.body._id) }, body: { isActive: true } })

  // ── token rotation retires the old URL ────────────────────────────────────
  const rotated = await call(updateStudentClassLink, {
    params: { id: String(created.body._id) },
    body: { regenerateToken: true },
  })
  check('rotation mints a new token', rotated.body?.token && rotated.body.token !== token)
  const oldToken = await call(getPublicStudentClassLink, { params: { token } })
  check('old token stops working', oldToken.body?.found === false)
  const newToken = await call(getPublicStudentClassLink, { params: { token: rotated.body.token } })
  check('new token works', newToken.body?.found === true && newToken.body?.active === true)

  // ── bulk: one link, many students, one page each ──────────────────────────
  const bulk = await call(bulkAssignStudentClassLinks, {
    body: {
      studentIds: [String(alpha._id), String(beta._id), String(gamma._id)],
      url: 'https://meet.google.com/smoke-batch',
      label: 'Batch A',
    },
  })
  check('bulk creates the missing two', bulk.body?.created === 2, JSON.stringify(bulk.body))
  check('bulk updates the existing one', bulk.body?.updated === 1, JSON.stringify(bulk.body))

  const batch = await StudentClassLink.find({ student: { $in: touched } }).lean()
  check('bulk wrote three links', batch.length === 3, String(batch.length))
  check('every student got their OWN token', new Set(batch.map(l => l.token)).size === 3)
  check('all three point at the same room', new Set(batch.map(l => l.url)).size === 1)
  check('each page greets its own student',
    batch.every(l => l.studentName === students.find(s => String(s._id) === String(l.student)).name))

  // ── bulk with skipExisting leaves them alone ──────────────────────────────
  const skipped = await call(bulkAssignStudentClassLinks, {
    body: {
      studentIds: touched.map(String),
      url: 'https://meet.google.com/should-not-apply',
      skipExisting: true,
    },
  })
  check('skipExisting skips all three', skipped.body?.skipped === 3, JSON.stringify(skipped.body))
  const untouched = await StudentClassLink.find({ student: { $in: touched } }).lean()
  check('skipExisting changed nothing',
    untouched.every(l => l.url === 'https://meet.google.com/smoke-batch'))

  // ── validation ────────────────────────────────────────────────────────────
  const noUrl = await call(upsertStudentClassLink, { body: { studentId: String(alpha._id) } })
  check('create without a url is rejected', noUrl.statusCode === 400, `got ${noUrl.statusCode}`)
  const noStudents = await call(bulkAssignStudentClassLinks, { body: { studentIds: [], url: 'https://x.test' } })
  check('bulk without students is rejected', noStudents.statusCode === 400, `got ${noStudents.statusCode}`)

  // ── delete ────────────────────────────────────────────────────────────────
  const one = await StudentClassLink.findOne({ student: alpha._id }).lean()
  const removed = await call(deleteStudentClassLink, { params: { id: String(one._id) } })
  check('single delete succeeds', removed.statusCode === 200)
  const afterDelete = await call(getPublicStudentClassLink, { params: { token: one.token } })
  check('deleted page stops resolving', afterDelete.body?.found === false)

  const bulkGone = await call(bulkDeleteStudentClassLinks, { body: { studentIds: touched.map(String) } })
  check('bulk delete removes the rest', bulkGone.body?.deleted === 2, JSON.stringify(bulkGone.body))
  check('nothing left behind', await StudentClassLink.countDocuments({ student: { $in: touched } }) === 0)
} finally {
  await StudentClassLink.deleteMany({ student: { $in: touched } })
  await mongoose.disconnect()
}

console.log(`\n${failures ? `${failures} check(s) failed.` : 'All checks passed.'}`)
process.exit(failures ? 1 : 0)

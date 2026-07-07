// Smoke test for role-targeted notices.
// Verifies createNotice persists targetRoles and getActiveNoticesForUser
// delivers role notices only to matching roles, while global notices still
// reach everyone (regression). Run: node scripts/smoke-notice-roles.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import Notice from '../models/Notice.js'
import Notification from '../models/Notification.js'
import { createNotice, getActiveNoticesForUser } from '../controllers/portalNoticeController.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }

function mockRes() {
  const res = { _status: 200, _json: null }
  res.status = (c) => { res._status = c; return res }
  res.json = (d) => { res._json = d; return res }
  return res
}
const userReq = (roleKeys, extra = {}) => ({
  userId: new mongoose.Types.ObjectId(),
  user: { roles: roleKeys.map(k => ({ key: k })), linkedTutorId: null, ...extra },
  query: {}, params: {}, body: {},
})

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
  console.log('Connected.')

  const MARK = 'SMOKE-ROLE-NOTICE ' + Math.random().toString(36).slice(2, 8)
  const GLOBALMARK = 'SMOKE-GLOBAL-NOTICE ' + Math.random().toString(36).slice(2, 8)
  let roleNoticeId, globalNotice

  try {
    // 1) createNotice persists targetRoles (type maps to 'teacher')
    const cReq = { userId: new mongoose.Types.ObjectId(), body: { type: 'teacher', targetRoles: ['qci', 'principal'], message: MARK, category: 'information' } }
    const cRes = mockRes()
    await createNotice(cReq, cRes)
    ok(cRes._status === 201, 'createNotice returns 201')
    ok(Array.isArray(cRes._json?.targetRoles) && cRes._json.targetRoles.includes('qci'), 'targetRoles persisted on notice')
    roleNoticeId = cRes._json._id

    // A plain global notice (no targets, no roles)
    globalNotice = await Notice.create({ type: 'teacher', message: GLOBALMARK, category: 'information' })

    const hasMark = (arr, mark) => arr.some(n => n.message === mark)

    // 2) qci user receives the role notice
    let res = mockRes()
    await getActiveNoticesForUser(userReq(['qci']), res)
    ok(hasMark(res._json, MARK), 'qci user receives the qci/principal role notice')
    ok(hasMark(res._json, GLOBALMARK), 'qci user also receives the global notice')

    // 3) principal user receives it too
    res = mockRes()
    await getActiveNoticesForUser(userReq(['principal']), res)
    ok(hasMark(res._json, MARK), 'principal user receives the notice')

    // 4) a tutor (no qci/principal role) does NOT receive the role notice
    res = mockRes()
    await getActiveNoticesForUser(userReq(['tutor']), res)
    ok(!hasMark(res._json, MARK), 'tutor does NOT receive the management role notice')
    ok(hasMark(res._json, GLOBALMARK), 'tutor STILL receives the global notice (regression safe)')

    // 5) a student does NOT receive the role notice but sees global
    res = mockRes()
    await getActiveNoticesForUser(userReq(['student']), res)
    ok(!hasMark(res._json, MARK), 'student does NOT receive the management role notice')
  } finally {
    if (roleNoticeId) {
      await Notice.deleteOne({ _id: roleNoticeId })
      await Notification.deleteMany({ 'payload.noticeId': roleNoticeId })
    }
    if (globalNotice) await Notice.deleteOne({ _id: globalNotice._id })
    console.log('Cleaned up temp notices/notifications.')
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  await mongoose.disconnect()
  process.exit(fail ? 1 : 0)
}

run().catch(e => { console.error('SMOKE ERROR:', e); process.exit(1) })

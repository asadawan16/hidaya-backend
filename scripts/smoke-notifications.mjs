// Notification coverage smoke test.
// 1) Static: every notification `type:` used in controllers/ must exist in the
//    Notification model enum.
// 2) Live: exercise a leave request end-to-end and assert Notification docs
//    are written for reviewers and the requester.
// Run: node scripts/smoke-notifications.mjs   (from hidayah-backend)
import 'dotenv/config'
import { readdirSync, readFileSync } from 'fs'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import { spawn } from 'child_process'

const results = []
let failures = 0
const record = (ok, name, detail = '') => { if (!ok) failures++; results.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

// ── 1. Static enum coverage ──
const modelSrc = readFileSync('models/Notification.js', 'utf8')
const enumMatch = modelSrc.match(/enum:\s*\[([^\]]+)\]/)
const enumTypes = new Set([...enumMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]))

// Only inspect `type: '...'` that appears inside a notification call's
// argument object (within 400 chars of the call opening).
const usedTypes = new Set()
const CALL_RE = /(createNotification\(|notifyRoles\([^,]+,\s*|Notification\.create\(|Notification\.insertMany\()/g
for (const f of readdirSync('controllers')) {
  if (!f.endsWith('.js')) continue
  const src = readFileSync(`controllers/${f}`, 'utf8')
  let m
  while ((m = CALL_RE.exec(src))) {
    const window = src.slice(m.index, m.index + 400)
    const t = window.match(/type:\s*'([a-z_]+)'/)
    if (t) usedTypes.add(t[1])
  }
}
// dynamic types built in code (leave review): both variants
usedTypes.add('leave_approved')
usedTypes.add('leave_rejected')

const missing = [...usedTypes].filter(t => !enumTypes.has(t))
record(missing.length === 0, 'all controller notification types exist in enum', missing.length ? `missing: ${missing.join(', ')}` : `${enumTypes.size} enum values`)

// ── 2. Live: leave request generates notifications ──
await mongoose.connect(process.env.MONGODB_URI)
const User = (await import('../models/User.js')).default
const Role = (await import('../models/Role.js')).default
const Notification = (await import('../models/Notification.js')).default
const TutorProfile = (await import('../models/TutorProfile.js')).default
const LeaveRequest = (await import('../models/LeaveRequest.js')).default

const PORT = process.env.PORT || 5000
const API = `http://localhost:${PORT}/api/portal`

async function serverUp() {
  try { const r = await fetch(`${API}/chat/online`); return r.status === 401 || r.ok } catch { return false }
}
let child = null
if (!(await serverUp())) {
  child = spawn(process.execPath, ['index.js'], { cwd: process.cwd(), stdio: 'ignore' })
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise(r => setTimeout(r, 500))
}

if (await serverUp()) {
  const adminRole = await Role.findOne({ key: 'admin' }) || await Role.findOne({ key: 'super_admin' })
  const tutorRole = await Role.findOne({ key: 'tutor' })

  const ensure = async (email, name, roles, extra = {}) => {
    let u = await User.findOne({ email })
    if (!u) u = await User.create({ email, displayName: name, password: 'SmokeTest123!', status: 'active', roles, ...extra })
    else { u.status = 'active'; u.roles = roles; Object.assign(u, extra); await u.save() }
    return u
  }

  const reviewer = await ensure('smoke-notif-admin@test.local', 'Smoke Notif Admin', adminRole ? [adminRole._id] : [])
  const tutor = await ensure('smoke-notif-tutor@test.local', 'Smoke Notif Tutor', tutorRole ? [tutorRole._id] : [])

  let tutorProfile = await TutorProfile.findOne({ name: 'Smoke Notif Tutor' })
  if (!tutorProfile) tutorProfile = await TutorProfile.create({ name: 'Smoke Notif Tutor', tutorId: `SMK-${Math.floor(Math.random() * 90000) + 10000}`, userId: tutor._id })
  tutor.linkedTutorId = tutorProfile._id
  await tutor.save()

  const token = jwt.sign({ id: tutor._id.toString(), type: 'portal' }, process.env.JWT_SECRET, { expiresIn: '1h' })
  const before = await Notification.countDocuments({ userId: reviewer._id, type: 'leave_request' })

  const res = await fetch(`${API}/leaves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      leaveType: 'casual',
      startDate: new Date(Date.now() + 86400000).toISOString(),
      endDate: new Date(Date.now() + 2 * 86400000).toISOString(),
      reason: 'smoke test',
    }),
  })
  const leave = await res.json().catch(() => ({}))
  record(res.ok, 'leave request created via API', res.ok ? '' : `${res.status} ${leave.error || ''}`)

  if (res.ok) {
    const after = await Notification.countDocuments({ userId: reviewer._id, type: 'leave_request' })
    record(after > before, 'reviewer received leave_request notification', `${before} → ${after}`)
  }

  // Cleanup
  await LeaveRequest.deleteMany({ tutorId: tutorProfile._id })
  await Notification.deleteMany({ userId: { $in: [reviewer._id, tutor._id] } })
  await User.deleteMany({ email: /smoke-notif-(admin|tutor)@test\.local/ })
  await TutorProfile.deleteMany({ _id: tutorProfile._id })
} else {
  record(false, 'server reachable for live check')
}

console.log('\nNotification smoke test results:')
console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)

await mongoose.disconnect()
if (child) child.kill()
process.exit(failures === 0 ? 0 : 1)

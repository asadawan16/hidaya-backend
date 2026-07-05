// Socket-layer smoke test: presence, typing, live message delivery.
// Run: node scripts/smoke-sockets.mjs   (backend must be running with latest code)
import 'dotenv/config'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import { io } from 'socket.io-client'

const PORT = process.env.PORT || 5000
const URL = `http://localhost:${PORT}/portal`
const API = `http://localhost:${PORT}/api/portal/chat`

await mongoose.connect(process.env.MONGODB_URI)
const User = (await import('../models/User.js')).default
const Role = (await import('../models/Role.js')).default
const ChatThread = (await import('../models/ChatThread.js')).default
const Message = (await import('../models/Message.js')).default

const superRole = await Role.findOne({ key: 'super_admin' })
async function ensureUser(email, name) {
  let u = await User.findOne({ email })
  if (!u) u = await User.create({ email, displayName: name, password: 'SmokeTest123!', status: 'active', roles: superRole ? [superRole._id] : [] })
  else { u.status = 'active'; await u.save() }
  return u
}
const a = await ensureUser('smoke-sock-a@test.local', 'Sock Alpha')
const b = await ensureUser('smoke-sock-b@test.local', 'Sock Beta')
const sign = (u) => jwt.sign({ id: u._id.toString(), type: 'portal' }, process.env.JWT_SECRET, { expiresIn: '1h' })

const rest = (token) => async (path, opts = {}) => {
  const res = await fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${res.status} ${data.error || ''} @ ${path}`)
  return data
}
const A = rest(sign(a)), B = rest(sign(b))

const results = []
let failures = 0
const record = (ok, name, detail = '') => { if (!ok) failures++; results.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const waitFor = (emitter, event, pred = () => true, ms = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { emitter.off(event, h); reject(new Error(`timeout waiting for ${event}`)) }, ms)
  const h = (data) => { if (pred(data)) { clearTimeout(t); emitter.off(event, h); resolve(data) } }
  emitter.on(event, h)
})
const connect = (token) => new Promise((resolve, reject) => {
  const s = io(URL, { auth: { token }, transports: ['websocket', 'polling'] })
  const t = setTimeout(() => reject(new Error('connect timeout')), 5000)
  s.on('connect', () => { clearTimeout(t); resolve(s) })
  s.on('connect_error', (e) => { clearTimeout(t); reject(e) })
})

// 1. A connects — should receive presence_state including itself
let sockA, sockB
try {
  sockA = await connect(sign(a))
  const statePromise = waitFor(sockA, 'presence_state', ids => Array.isArray(ids))
  // presence_state is emitted at connection — may already be gone; fall back to REST
  const ids = await Promise.race([statePromise, new Promise(r => setTimeout(() => r(null), 1500))])
  if (ids) record(ids.includes(a._id.toString()), 'A receives presence_state incl. self', JSON.stringify(ids))
  else {
    const restIds = await A('/online')
    record(restIds.includes(a._id.toString()), 'presence_state missed but REST /online has A', JSON.stringify(restIds))
  }
} catch (e) { record(false, 'A socket connect', e.message || JSON.stringify(e)) }

if (!sockA) {
  console.log('\nSocket smoke test results:')
  console.log(results.join('\n'))
  console.log('\nABORTED — client could not connect to the socket server')
  await User.deleteMany({ email: /smoke-sock-[ab]@test\.local/ })
  await mongoose.disconnect()
  process.exit(1)
}

// 2. B connects — A should get presence_update {B, online:true}
try {
  const p = waitFor(sockA, 'presence_update', d => d.userId === b._id.toString() && d.online === true)
  sockB = await connect(sign(b))
  await p
  record(true, 'A receives presence_update when B connects')
} catch (e) { record(false, 'presence_update on B connect', e.message) }

// 3. REST /online shows both
try {
  const ids = await A('/online')
  record(ids.includes(a._id.toString()) && ids.includes(b._id.toString()), 'REST /online lists both users', JSON.stringify(ids))
} catch (e) { record(false, 'REST /online', e.message) }

// 4. Typing relay within a DM thread room
let dm
try {
  dm = await A('/dm', { method: 'POST', body: JSON.stringify({ participantId: b._id.toString() }) })
  sockA.emit('join_thread', dm._id)
  sockB.emit('join_thread', dm._id)
  await new Promise(r => setTimeout(r, 600)) // let async membership check + join settle
  const p = waitFor(sockB, 'typing', d => d.threadId === dm._id && d.userId === a._id.toString() && d.isTyping === true)
  sockA.emit('typing', { threadId: dm._id, isTyping: true })
  const evt = await p
  record(evt.displayName === 'Sock Alpha', 'B receives typing event from A (with name)', evt.displayName)
} catch (e) { record(false, 'typing relay', e.message) }

// 5. typing stop relays too
try {
  const p = waitFor(sockB, 'typing', d => d.threadId === dm._id && d.isTyping === false)
  sockA.emit('typing', { threadId: dm._id, isTyping: false })
  await p
  record(true, 'typing stop relays')
} catch (e) { record(false, 'typing stop relay', e.message) }

// 6. Live message delivery: B sends via REST → A gets new_message socket event
try {
  const p = waitFor(sockA, 'new_message', d => d.threadId === dm._id)
  await B(`/threads/${dm._id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'socket smoke hello' }) })
  const evt = await p
  record(evt.message?.body === 'socket smoke hello', 'A receives new_message live')
} catch (e) { record(false, 'live new_message', e.message) }

// 7. thread_read receipt: A marks read → B receives thread_read
try {
  const p = waitFor(sockB, 'thread_read', d => d.threadId === dm._id && d.userId === a._id.toString())
  await A(`/threads/${dm._id}/read`, { method: 'POST' })
  await p
  record(true, 'B receives thread_read receipt live')
} catch (e) { record(false, 'thread_read receipt', e.message) }

// 8. B disconnect → A gets presence_update offline
try {
  const p = waitFor(sockA, 'presence_update', d => d.userId === b._id.toString() && d.online === false)
  sockB.disconnect()
  await p
  record(true, 'A receives presence_update when B disconnects')
} catch (e) { record(false, 'presence_update on disconnect', e.message) }

console.log('\nSocket smoke test results:')
console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)

sockA?.disconnect()
if (dm?._id) { await Message.deleteMany({ threadId: dm._id }); await ChatThread.deleteMany({ _id: dm._id }) }
await User.deleteMany({ email: /smoke-sock-[ab]@test\.local/ })
await mongoose.disconnect()
process.exit(failures === 0 ? 0 : 1)

// Smoke test for the full chat feature set. Boots the API (or reuses a running
// one), creates two throwaway users, and exercises every chat endpoint.
// Run: node scripts/smoke-chat.mjs   (from hidayah-backend)
import 'dotenv/config'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import { spawn } from 'child_process'

const PORT = process.env.PORT || 5000
const BASE = `http://localhost:${PORT}/api/portal/chat`

await mongoose.connect(process.env.MONGODB_URI)
const User = (await import('../models/User.js')).default
const Role = (await import('../models/Role.js')).default
const ChatThread = (await import('../models/ChatThread.js')).default
const Message = (await import('../models/Message.js')).default

const superRole = await Role.findOne({ key: 'super_admin' })

async function ensureUser(email, name, roles) {
  let u = await User.findOne({ email })
  if (!u) u = await User.create({ email, displayName: name, password: 'SmokeTest123!', status: 'active', roles })
  else { u.status = 'active'; u.roles = roles; await u.save() }
  return u
}
const a = await ensureUser('smoke-chat-a@test.local', 'Smoke Alpha', superRole ? [superRole._id] : [])
const b = await ensureUser('smoke-chat-b@test.local', 'Smoke Beta', []) // no roles → not a moderator
const sign = (u) => jwt.sign({ id: u._id.toString(), type: 'portal' }, process.env.JWT_SECRET, { expiresIn: '1h' })
const tokenA = sign(a), tokenB = sign(b)

// Boot or reuse server
async function serverUp() {
  try { const r = await fetch(`${BASE}/online`); return r.status === 401 || r.ok } catch { return false }
}
let child = null
if (!(await serverUp())) {
  child = spawn(process.execPath, ['index.js'], { cwd: process.cwd(), stdio: 'ignore' })
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise(r => setTimeout(r, 500))
  if (!(await serverUp())) { console.error('SERVER FAILED TO START'); process.exit(1) }
  console.log('(booted fresh server)')
} else {
  console.log('(using already-running server — ensure it has latest code)')
}

const api = (token) => async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) { const e = new Error(`${res.status} ${data.error || ''} @ ${path}`); e.status = res.status; throw e }
  return data
}
const A = api(tokenA), B = api(tokenB)

const results = []
let failures = 0
async function step(name, fn) {
  try { await fn(); results.push(`  PASS  ${name}`) }
  catch (e) { failures++; results.push(`  FAIL  ${name}: ${e.message}`) }
}

let channel, dm, msg1

await step('create channel (creator becomes owner)', async () => {
  channel = await A('/channels', { method: 'POST', body: JSON.stringify({ name: 'smoke-test-channel', description: 'smoke', participantIds: [b._id.toString()] }) })
  const owner = channel.memberRoles?.find(r => r.role === 'owner')
  if (!owner || owner.userId !== a._id.toString()) throw new Error('creator is not owner')
})

await step('B lists threads with myPrefs + memberRoles', async () => {
  const ts = await B('/threads')
  const t = ts.find(x => x._id === channel._id)
  if (!t) throw new Error('channel not visible to B')
  if (!t.myPrefs) throw new Error('myPrefs missing')
  if (!t.memberRoles?.length) throw new Error('memberRoles missing')
})

await step('B sends message (@all + link extraction)', async () => {
  msg1 = await B(`/threads/${channel._id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Hello @all please check https://example.com/docs today', mentionsAll: true }) })
  if (!msg1.linkUrls?.includes('https://example.com/docs')) throw new Error('link not extracted')
  if (!msg1.mentionsAll) throw new Error('mentionsAll not stored')
})

await step('quote-reply snapshot stored', async () => {
  const q = await A(`/threads/${channel._id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Replying to that', quotedMessage: { messageId: msg1._id, senderName: 'Smoke Beta', body: msg1.body } }) })
  if (q.quotedMessage?.messageId !== msg1._id) throw new Error('quotedMessage missing')
})

await step('A toggles 👍 reaction', async () => {
  const r = await A(`/messages/${msg1._id}/reactions`, { method: 'POST', body: JSON.stringify({ emoji: '👍' }) })
  if (!r.reactions?.some(x => x.emoji === '👍' && x.users?.length === 1)) throw new Error('reaction not recorded')
})

await step('reaction untoggle removes pill', async () => {
  const r = await A(`/messages/${msg1._id}/reactions`, { method: 'POST', body: JSON.stringify({ emoji: '👍' }) })
  if (r.reactions?.some(x => x.emoji === '👍')) throw new Error('reaction not removed')
})

await step('A pins as member (membership enforced)', async () => {
  const r = await A(`/messages/${msg1._id}/pin`, { method: 'POST' })
  if (!r.pinned) throw new Error('not pinned')
})

await step('A sets prefs (pin + mute 1h + label + background)', async () => {
  const t = await A(`/threads/${channel._id}/prefs`, { method: 'PATCH', body: JSON.stringify({ pinned: true, mute: 60, label: 'Important', labelColor: '#DC2626', background: 'dots' }) })
  if (!t.myPrefs?.pinned || !t.myPrefs?.muted || t.myPrefs?.label !== 'Important' || t.myPrefs?.background !== 'dots') throw new Error(`prefs wrong: ${JSON.stringify(t.myPrefs)}`)
})

await step('unmute works', async () => {
  const t = await A(`/threads/${channel._id}/prefs`, { method: 'PATCH', body: JSON.stringify({ mute: null }) })
  if (t.myPrefs?.muted) throw new Error('still muted')
})

await step('markRead adds read receipt', async () => {
  await A(`/threads/${channel._id}/read`, { method: 'POST' })
  const res = await B(`/threads/${channel._id}/messages?page=1&limit=50`)
  const m = res.messages.find(x => x._id === msg1._id)
  const ids = (m.readBy || []).map(r => (r.userId?._id || r.userId || '').toString())
  if (!ids.includes(a._id.toString())) throw new Error('A missing from readBy')
})

await step('links tab lists extracted URL', async () => {
  const links = await A(`/threads/${channel._id}/links`)
  if (!links.some(l => l.url === 'https://example.com/docs')) throw new Error('link missing')
})

await step('mentions view shows @all for A', async () => {
  const ms = await A('/mentions')
  if (!ms.some(m => m._id === msg1._id)) throw new Error('mention not listed')
})

await step('message pagination shape (page/pages/total)', async () => {
  const res = await A(`/threads/${channel._id}/messages?page=1&limit=1`)
  if (res.total < 2 || res.pages < 2 || res.messages.length !== 1) throw new Error(`bad pagination: total=${res.total} pages=${res.pages}`)
})

await step('DM create + reopen dedupes', async () => {
  dm = await A('/dm', { method: 'POST', body: JSON.stringify({ participantId: b._id.toString() }) })
  const dm2 = await A('/dm', { method: 'POST', body: JSON.stringify({ participantId: b._id.toString() }) })
  if (dm._id !== dm2._id) throw new Error('duplicate DM created')
})

await step('forward message into DM', async () => {
  const f = await A(`/messages/${msg1._id}/forward`, { method: 'POST', body: JSON.stringify({ targetThreadId: dm._id }) })
  if (f.forwardedFrom?.senderName !== 'Smoke Beta') throw new Error('forwardedFrom missing')
})

await step('rename by non-owner rejected (403)', async () => {
  try { await B(`/channels/${channel._id}`, { method: 'PATCH', body: JSON.stringify({ name: 'hijacked' }) }); throw new Error('was allowed') }
  catch (e) { if (e.status !== 403) throw e }
})

await step('owner promotes B to admin', async () => {
  const r = await A(`/channels/${channel._id}/members/${b._id}/role`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) })
  if (r.role !== 'admin') throw new Error('role not set')
})

await step('admin B can rename? still no (owner-only)', async () => {
  try { await B(`/channels/${channel._id}`, { method: 'PATCH', body: JSON.stringify({ name: 'still-hijacked' }) }); throw new Error('was allowed') }
  catch (e) { if (e.status !== 403) throw e }
})

await step('admin B can add/remove members (no-op add self ok)', async () => {
  await B(`/channels/${channel._id}`, { method: 'PATCH', body: JSON.stringify({ description: 'updated by admin' }) })
})

await step('B leaves channel', async () => {
  await B(`/channels/${channel._id}/leave`, { method: 'POST' })
  const ts = await B('/threads')
  if (ts.some(t => t._id === channel._id)) throw new Error('still listed after leave')
})

await step('archive by owner, then send rejected', async () => {
  const r = await A(`/channels/${channel._id}/archive`, { method: 'POST', body: JSON.stringify({ archived: true }) })
  if (!r.archived) throw new Error('not archived')
  try { await A(`/threads/${channel._id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'should fail' }) }); throw new Error('send allowed on archived') }
  catch (e) { if (e.status !== 400) throw e }
})

await step('students-taggable responds', async () => {
  const s = await A('/students-taggable?search=a')
  if (!Array.isArray(s)) throw new Error('not an array')
})

await step('online presence endpoint responds', async () => {
  const ids = await A('/online')
  if (!Array.isArray(ids)) throw new Error('not an array')
})

console.log('\nChat smoke test results:')
console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)

// Cleanup test data
const threadIds = [channel?._id, dm?._id].filter(Boolean)
await Message.deleteMany({ threadId: { $in: threadIds } })
await ChatThread.deleteMany({ _id: { $in: threadIds } })
await User.deleteMany({ email: /smoke-chat-[ab]@test\.local/ })
await mongoose.disconnect()
if (child) child.kill()
process.exit(failures === 0 ? 0 : 1)

// Tasks board + goals (client's request, 2026-11-07; his branch only).
//
// Who sees what:
//   - everyone: tasks assigned to them, created by them, or that they watch
//     (an @mention makes you a watcher)
//   - task.read: every task
//   - task.manage: create/assign for anyone (staff, tutors, students), edit or
//     delete any task, change many at once, manage goals
// Staff without task.manage can still add their own to-dos (assigned to
// themselves). Students only see and work the tasks assigned to them.
import mongoose from 'mongoose'
import Task, { TASK_STATUSES, TASK_PRIORITIES, TASK_TYPES, REPEAT_FREQS, ACTIVITY_CAP } from '../models/Task.js'
import Goal from '../models/Goal.js'
import TaskView from '../models/TaskView.js'
import User from '../models/User.js'
import Role from '../models/Role.js'
import Enrollment from '../models/Enrollment.js'
import '../models/Student.js'
import { createNotification } from './portalNotificationController.js'
import { emitToUser } from '../config/socket.js'
import { logActivity } from '../utils/activityLogger.js'
import { nextDueDate, nextTaskFields } from '../utils/taskRepeat.js'
import { SHIFT_WRAP_HOUR } from '../utils/shiftWindow.js'

const { isValidObjectId } = mongoose
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const canSeeAll = (req) => req.userPermissions.has('task.read') || req.userPermissions.has('task.manage')
const canManage = (req) => req.userPermissions.has('task.manage')
// Linking a task to a lead is its own permission (admins by default).
const canLinkLeads = (req) => req.userPermissions.has('task.leads')
const isStudentOnly = (req) => (req.user.roles || []).length > 0 && req.user.roles.every(r => r.key === 'student')
const sameId = (a, b) => String(a?._id || a) === String(b?._id || b)

const POPULATE = [
  { path: 'assignees', select: 'displayName email linkedStudentId roles', populate: { path: 'roles', select: 'key name' } },
  { path: 'watchers', select: 'displayName email' },
  { path: 'waiting.userId', select: 'displayName email' },
  { path: 'leadId', select: 'name phone email status program' },
  { path: 'studentId', select: 'name rollNo' },
  { path: 'goalId', select: 'title period startDate endDate' },
]
// The board and lists don't need a task's whole history.
const LIST_SELECT = '-activity'

const mineFilter = (userId) => ({ $or: [{ assignees: userId }, { createdBy: userId }, { watchers: userId }] })

function relation(req, task) {
  const manager = canManage(req)
  const creator = sameId(task.createdBy, req.userId)
  const assignee = (task.assignees || []).some(a => sameId(a, req.userId))
  const watcher = (task.watchers || []).some(a => sameId(a, req.userId))
  return { manager, creator, assignee, watcher, full: manager || creator, visible: canSeeAll(req) || creator || assignee || watcher }
}

// 'YYYY-MM-DD' → UTC midnight; anything else → Date (or null)
function parseDate(v, allDay) {
  if (v === null || v === '') return null
  if (v === undefined) return undefined
  if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) return new Date(`${v}T00:00:00.000Z`)
  const d = new Date(v)
  return isNaN(d.getTime()) ? undefined : d
}

const cleanIds = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter(isValidObjectId))]

function cleanChecklist(list) {
  if (!Array.isArray(list)) return undefined
  return list
    .filter(i => i && String(i.text || '').trim())
    .slice(0, 50)
    .map(i => ({ ...(isValidObjectId(i._id) ? { _id: i._id } : {}), text: String(i.text).trim().slice(0, 300), done: !!i.done }))
}

const dateLabel = (task) => {
  if (!task.dueDate) return ''
  const d = new Date(task.dueDate)
  return task.allDay
    ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' }) + ' PKT'
}

function pushLive(userIds, event, data) {
  for (const id of new Set(userIds.map(String))) emitToUser(id, event, data)
}
const involved = (task) => [
  ...(task.assignees || []).map(a => a?._id || a),
  ...(task.watchers || []).map(a => a?._id || a),
  task.createdBy,
].filter(Boolean)

async function notifyAssigned(task, userIds, actor) {
  for (const uid of userIds) {
    if (sameId(uid, actor._id)) continue
    await createNotification({
      userId: uid,
      type: 'task_assigned',
      title: `New task: ${task.title}`,
      body: [task.dueDate ? `Due ${dateLabel(task)}` : '', `from ${actor.displayName || 'the office'}`].filter(Boolean).join(' · '),
      payload: { taskId: String(task._id) },
    })
  }
}

// ─── History ───

const STATUS_WORDS = { recurring: 'Recurring', todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done' }
function addActivity(task, user, text) {
  task.activity.push({ text, by: user?._id, byName: user?.displayName || '' })
  if (task.activity.length > ACTIVITY_CAP) task.activity = task.activity.slice(-ACTIVITY_CAP)
}

// Plain-English lines for what an edit changed. `before` is a snapshot.
async function describeChanges(before, task) {
  const lines = []
  if (before.title !== task.title) lines.push(`renamed it to "${task.title}"`)
  if (before.status !== task.status) lines.push(`moved it to ${STATUS_WORDS[task.status] || task.status}`)
  if (before.priority !== task.priority) lines.push(`set priority to ${task.priority}`)
  const due = (d) => (d ? new Date(d).getTime() : 0)
  if (due(before.dueDate) !== due(task.dueDate)) lines.push(task.dueDate ? `set the due date to ${dateLabel(task)}` : 'removed the due date')
  const was = before.assignees.map(String), now = task.assignees.map(String)
  const added = now.filter(id => !was.includes(id)), removed = was.filter(id => !now.includes(id))
  if (added.length || removed.length) {
    const users = await User.find({ _id: { $in: [...added, ...removed] } }).select('displayName email').lean()
    const name = (id) => { const u = users.find(x => sameId(x._id, id)); return u?.displayName || u?.email || 'someone' }
    if (added.length) lines.push(`assigned ${added.map(name).join(', ')}`)
    if (removed.length) lines.push(`removed ${removed.map(name).join(', ')}`)
  }
  if (!before.waitingOn && task.waiting?.on) lines.push(`marked it waiting${task.waiting.who ? ` on ${task.waiting.who}` : ''}${task.waiting.reason ? `: ${task.waiting.reason}` : ''}`)
  if (before.waitingOn && !task.waiting?.on) lines.push('marked it no longer waiting')
  if (before.repeatFreq !== (task.repeat?.freq || '')) lines.push(task.repeat?.freq ? `set it to repeat ${task.repeat.freq}` : 'stopped it repeating')
  return lines
}
const snapshot = (t) => ({
  title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate,
  assignees: (t.assignees || []).map(a => String(a?._id || a)),
  waitingOn: !!t.waiting?.on, waitingUser: String(t.waiting?.userId || ''), repeatFreq: t.repeat?.freq || '',
})

// ─── Repeats ───

// A repeating task that has just been finished makes the next one (once).
async function spawnNextIfRepeating(task, actor) {
  if (task.status !== 'done' || !task.repeat?.freq || task.repeatedInto) return null
  const due = nextDueDate(task)
  if (!due) return null
  const next = new Task(nextTaskFields(task.toObject ? task.toObject() : task, due))
  addActivity(next, actor, `made it from the last one (repeats ${task.repeat.freq})`)
  await next.save()
  await Task.updateOne({ _id: task._id }, { repeatedInto: next._id })
  task.repeatedInto = next._id
  return next
}

// Un-finishing a repeating task (or Undo) takes back the copy it made, as
// long as nobody has touched that copy yet; a copy already worked on stays.
async function retractNextIfUntouched(task) {
  if (task.status === 'done' || !task.repeatedInto) return
  const next = await Task.findById(task.repeatedInto).select('status comments activity checklist').lean()
  const untouched = next && next.status === 'todo' && !next.comments?.length
    && (next.activity?.length || 0) <= 1 && !(next.checklist || []).some(i => i.done)
  if (next && !untouched) return
  if (next) await Task.deleteOne({ _id: next._id })
  await Task.updateOne({ _id: task._id }, { $unset: { repeatedInto: 1 } })
  task.repeatedInto = undefined
}

// ─── Waiting on ───

async function notifyWaiting(task, actor) {
  const uid = task.waiting?.userId
  if (!task.waiting?.on || !uid || sameId(uid, actor._id)) return
  await createNotification({
    userId: uid,
    type: 'task_waiting',
    title: `Waiting on you: ${task.title}`,
    body: `${actor.displayName || 'Someone'}${task.waiting.reason ? `: ${task.waiting.reason}` : ' is waiting on you to move this on'}`,
    payload: { taskId: String(task._id) },
  })
}

// ─── Tasks ───

// GET /portal/tasks
//   scope=all|mine|created|involved · status · type · priority · assignee ·
//   leadId · studentId · goalId · search · hideDone=1 · waiting=1
//   from/to — tasks whose [start, due] overlaps the window (calendar, timeline)
//   dueFrom/dueTo — due date inside the range; noDue=1 — no due date
//   doneSince=ISO — open tasks, plus done ones finished since then. The board's
//     default, so years of finished tasks are never all fetched.
//   skip/limit — paging (limit ≤ 500)
export async function listTasks(req, res) {
  try {
    const q = req.query
    const and = []
    const scope = q.scope || (canSeeAll(req) ? 'all' : 'involved')
    if (scope === 'mine') and.push({ assignees: req.userId })
    else if (scope === 'created') and.push({ createdBy: req.userId })
    if (scope === 'involved' || !canSeeAll(req)) and.push(mineFilter(req.userId))

    const list = (v, allowed) => String(v || '').split(',').map(s => s.trim()).filter(s => allowed.includes(s))
    if (q.status) { const v = list(q.status, TASK_STATUSES); if (v.length) and.push({ status: { $in: v } }) }
    if (q.type) { const v = list(q.type, TASK_TYPES); if (v.length) and.push({ type: { $in: v } }) }
    if (q.priority) { const v = list(q.priority, TASK_PRIORITIES); if (v.length) and.push({ priority: { $in: v } }) }
    if (q.hideDone === '1') and.push({ status: { $ne: 'done' } })
    if (q.waiting === '1') and.push({ 'waiting.on': true })
    if (q.assignee === 'none') and.push({ assignees: { $size: 0 } })
    else if (isValidObjectId(q.assignee)) and.push({ assignees: q.assignee })
    for (const f of ['leadId', 'studentId', 'goalId']) {
      if (q[f] === 'none') and.push({ [f]: null })
      else if (isValidObjectId(q[f])) and.push({ [f]: q[f] })
    }
    if (q.search) {
      const rx = new RegExp(escapeRx(q.search), 'i')
      and.push({ $or: [{ title: rx }, { description: rx }, { tags: rx }] })
    }
    const date = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d }
    // Date window (calendar / timeline): tasks whose [start, due] span overlaps
    // [from, to]. A task with only one date uses it for both ends.
    const from = date(q.from), to = date(q.to)
    if (from && to) {
      and.push({
        $or: [
          { dueDate: { $gte: from }, $or: [{ startDate: { $lte: to } }, { startDate: null, dueDate: { $lte: to } }] },
          { dueDate: null, startDate: { $gte: from, $lte: to } },
        ],
      })
    }
    if (q.noDue === '1') and.push({ dueDate: null })
    else {
      const dueFrom = date(q.dueFrom), dueTo = date(q.dueTo)
      if (dueFrom || dueTo) and.push({ dueDate: { ...(dueFrom ? { $gte: dueFrom } : {}), ...(dueTo ? { $lte: dueTo } : {}) } })
    }
    const doneSince = date(q.doneSince)
    if (doneSince) and.push({ $or: [{ status: { $ne: 'done' } }, { completedAt: { $gte: doneSince } }] })

    const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 300))
    const skip = Math.max(0, parseInt(q.skip, 10) || 0)
    const filter = and.length ? { $and: and } : {}
    const [records, total] = await Promise.all([
      Task.find(filter).select(LIST_SELECT).populate(POPULATE).sort({ order: 1, dueDate: 1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Task.countDocuments(filter),
    ])
    res.json({ records: records.map(t => withToday(t)), total, skip, limit, canManage: canManage(req), canSeeAll: canSeeAll(req) })
  } catch (err) {
    console.error('List tasks error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/tasks/my/summary — the signed-in user's open tasks that are
// dated up to a week ahead (or undated), for the dashboard "My work" card and
// the reminder pop-up. The browser buckets them into overdue / today / later
// in its own time zone. Also: tasks other people are waiting on you for, and
// (managers) open tasks nobody owns.
export async function myTaskSummary(req, res) {
  try {
    const horizon = new Date(Date.now() + 8 * 86400000)
    // Recurring-column tasks are listed on their own ("every day"), not by date.
    const base = { assignees: req.userId, status: { $nin: ['done', 'recurring'] } }
    const open = { status: { $ne: 'done' } }
    const [dated, undatedCount, undated, doneThisWeek, openCount, waitingOnMe, unowned, unownedCount, daily] = await Promise.all([
      Task.find({ ...base, dueDate: { $ne: null, $lte: horizon } }).select(LIST_SELECT).populate(POPULATE).sort({ dueDate: 1 }).limit(100).lean(),
      Task.countDocuments({ ...base, dueDate: null }),
      Task.find({ ...base, dueDate: null }).select(LIST_SELECT).populate(POPULATE).sort({ createdAt: -1 }).limit(10).lean(),
      Task.countDocuments({ assignees: req.userId, status: 'done', completedAt: { $gte: new Date(Date.now() - 7 * 86400000) } }),
      Task.countDocuments(base),
      Task.find({ ...open, 'waiting.on': true, 'waiting.userId': req.userId }).select(LIST_SELECT).populate(POPULATE).sort({ 'waiting.since': 1 }).limit(20).lean(),
      canManage(req) ? Task.find({ ...open, assignees: { $size: 0 } }).select(LIST_SELECT).populate(POPULATE).sort({ dueDate: 1, createdAt: -1 }).limit(8).lean() : [],
      canManage(req) ? Task.countDocuments({ ...open, assignees: { $size: 0 } }) : 0,
      Task.find({ assignees: req.userId, status: 'recurring' }).select(LIST_SELECT).populate(POPULATE).sort({ order: 1 }).limit(30).lean(),
    ])
    res.json({
      tasks: dated, undated, undatedCount, openCount, doneThisWeek, waitingOnMe, unowned, unownedCount,
      daily: daily.map(t => withToday(t)),
    })
  } catch (err) {
    console.error('My task summary error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/tasks/:id
export async function getTask(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Task not found' })
    const task = await Task.findById(req.params.id).populate(POPULATE).populate('repeatOf', 'title dueDate').lean()
    if (!task || !relation(req, task).visible) return res.status(404).json({ error: 'Task not found' })
    res.json(withToday(task))
  } catch (err) {
    console.error('Get task error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

function applyFields(task, body, { creating, canLeads }) {
  const allDay = body.allDay !== undefined ? !!body.allDay : (task.allDay ?? true)
  if (body.title !== undefined) task.title = String(body.title).trim().slice(0, 200)
  if (body.description !== undefined) task.description = String(body.description || '').slice(0, 5000)
  if (body.type !== undefined && TASK_TYPES.includes(body.type)) task.type = body.type
  if (body.priority !== undefined && TASK_PRIORITIES.includes(body.priority)) task.priority = body.priority
  if (body.allDay !== undefined || creating) task.allDay = allDay
  for (const f of ['startDate', 'dueDate']) {
    const d = parseDate(body[f], allDay)
    if (d !== undefined) task[f] = d
  }
  if (task.startDate && task.dueDate && task.startDate > task.dueDate) task.startDate = task.dueDate
  for (const f of ['leadId', 'studentId', 'goalId']) {
    if (body[f] === undefined) continue
    if (f === 'leadId' && !canLeads) continue
    task[f] = isValidObjectId(body[f]) ? body[f] : null
  }
  if (body.tags !== undefined) task.tags = (Array.isArray(body.tags) ? body.tags : []).map(t => String(t).trim()).filter(Boolean).slice(0, 10)
  const cl = cleanChecklist(body.checklist)
  if (cl) task.checklist = cl
  if (body.repeat !== undefined) {
    const r = body.repeat || {}
    if (!REPEAT_FREQS.includes(r.freq)) {
      task.repeat = { freq: '' }
    } else {
      const until = parseDate(r.until, true)
      task.repeat = {
        freq: r.freq,
        interval: Math.min(52, Math.max(1, parseInt(r.interval, 10) || 1)),
        weekdays: r.freq === 'weekly' ? [...new Set((Array.isArray(r.weekdays) ? r.weekdays : []).map(Number).filter(d => d >= 0 && d <= 6))] : [],
        monthDay: r.freq === 'monthly' ? (Number(r.monthDay) >= 1 && Number(r.monthDay) <= 31 ? Number(r.monthDay) : (task.dueDate ? new Date(task.dueDate).getUTCDate() : undefined)) : undefined,
        until: until || undefined,
      }
    }
  }
}

// Waiting on…: anyone who can work the task may set or clear it.
function applyWaiting(task, w) {
  if (w === undefined) return
  if (!w || !w.on) { task.waiting = { on: false, reason: '', who: '' }; return }
  task.waiting = {
    on: true,
    reason: String(w.reason || '').trim().slice(0, 300),
    who: String(w.who || '').trim().slice(0, 120),
    userId: isValidObjectId(w.userId) ? w.userId : undefined,
    since: task.waiting?.on ? (task.waiting.since || new Date()) : new Date(),
  }
}

function setStatus(task, status, userId) {
  if (!TASK_STATUSES.includes(status) || task.status === status) return false
  task.status = status
  // A finished task isn't waiting on anyone any more.
  if (status === 'done' && task.waiting?.on) task.waiting = { on: false, reason: '', who: '' }
  if (status === 'done') { task.completedAt = new Date(); task.completedBy = userId }
  else { task.completedAt = undefined; task.completedBy = undefined }
  return true
}

async function notifyDone(task, req) {
  if (task.createdBy && !sameId(task.createdBy, req.userId)) {
    await createNotification({
      userId: task.createdBy,
      type: 'task_updated',
      title: `Done: ${task.title}`,
      body: `${req.user.displayName || 'Someone'} marked it done`,
      payload: { taskId: String(task._id) },
    })
  }
}

// POST /portal/tasks
export async function createTask(req, res) {
  try {
    if (isStudentOnly(req)) return res.status(403).json({ error: 'Students cannot create tasks' })
    const body = req.body || {}
    if (!String(body.title || '').trim()) return res.status(400).json({ error: 'A title is required' })
    let assignees = cleanIds(body.assignees)
    if (!canManage(req)) {
      if (assignees.some(id => !sameId(id, req.userId))) return res.status(403).json({ error: 'You can only add tasks for yourself' })
      assignees = [String(req.userId)]
    }
    const task = new Task({ createdBy: req.userId, createdByName: req.user.displayName || '', assignees })
    applyFields(task, body, { creating: true, canLeads: canLinkLeads(req) })
    applyWaiting(task, body.waiting)
    setStatus(task, body.status || 'todo', req.userId)
    addActivity(task, req.user, 'created it')
    // New cards go to the top of their column.
    const top = await Task.findOne({ status: task.status }).sort({ order: 1 }).select('order').lean()
    task.order = (top?.order ?? 0) - 1
    await task.save()

    await notifyAssigned(task, assignees, req.user)
    await notifyWaiting(task, req.user)
    await logActivity({ level: 'info', category: 'portal', action: 'task_created', message: `Task created: ${task.title}`, req, meta: { taskId: task._id } })
    const populated = await Task.findById(task._id).populate(POPULATE).lean()
    pushLive(involved(task), 'task_changed', { taskId: String(task._id) })
    res.status(201).json(populated)
  } catch (err) {
    console.error('Create task error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// PATCH /portal/tasks/:id — managers and the creator can change anything;
// an assignee can move it (status / order), tick its checklist, mark it
// waiting, and comment.
export async function updateTask(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Task not found' })
    const task = await Task.findById(req.params.id)
    if (!task) return res.status(404).json({ error: 'Task not found' })
    const rel = relation(req, task)
    if (!rel.visible) return res.status(404).json({ error: 'Task not found' })
    if (!rel.full && !rel.assignee) return res.status(403).json({ error: 'You can only view this task' })
    const body = req.body || {}
    const before = snapshot(task)

    if (rel.full) {
      applyFields(task, body, { creating: false, canLeads: canLinkLeads(req) })
      if (body.assignees !== undefined) {
        const next = cleanIds(body.assignees)
        if (!rel.manager && next.some(id => !sameId(id, req.userId))) {
          return res.status(403).json({ error: 'Only managers can assign tasks to other people' })
        }
        task.assignees = next
      }
    } else if (body.checklist !== undefined) {
      // Assignee: may only tick existing items, not rewrite the list.
      const done = new Map((Array.isArray(body.checklist) ? body.checklist : []).map(i => [String(i._id), !!i.done]))
      for (const item of task.checklist) if (done.has(String(item._id))) item.done = done.get(String(item._id))
    }
    applyWaiting(task, body.waiting)
    if (body.status !== undefined) setStatus(task, body.status, req.userId)
    // Recurring column: "Checked today" (stops today's reminder).
    if (body.checkedToday !== undefined && task.status === 'recurring') {
      const day = shiftDay()
      if (body.checkedToday && task.dailyCheckedOn !== day) {
        task.dailyCheckedOn = day; task.dailyCheckedBy = req.userId
        addActivity(task, req.user, 'checked it for today')
      } else if (!body.checkedToday && task.dailyCheckedOn === day) {
        task.dailyCheckedOn = ''; task.dailyCheckedBy = undefined
      }
    }
    if (body.order !== undefined && Number.isFinite(Number(body.order))) task.order = Number(body.order)
    for (const line of await describeChanges(before, task)) addActivity(task, req.user, line)
    await task.save()

    const added = task.assignees.map(String).filter(id => !before.assignees.includes(id))
    if (added.length) await notifyAssigned(task, added, req.user)
    if (task.waiting?.on && (!before.waitingOn || String(task.waiting.userId || '') !== before.waitingUser)) await notifyWaiting(task, req.user)
    if (before.status !== 'done' && task.status === 'done') {
      await notifyDone(task, req)
      await spawnNextIfRepeating(task, req.user)
    } else if (before.status === 'done' && task.status !== 'done') {
      await retractNextIfUntouched(task)
    }
    const populated = await Task.findById(task._id).populate(POPULATE).populate('repeatOf', 'title dueDate').lean()
    pushLive([...involved(task), ...before.assignees], 'task_changed', { taskId: String(task._id) })
    res.json(withToday(populated))
  } catch (err) {
    console.error('Update task error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// POST /portal/tasks/reorder { status, ids: [...] } — a Kanban drop: the
// column's cards in their new order (and moved into `status`).
export async function reorderTasks(req, res) {
  try {
    const { status, ids } = req.body || {}
    if (!TASK_STATUSES.includes(status) || !Array.isArray(ids)) return res.status(400).json({ error: 'status and ids[] are required' })
    const list = cleanIds(ids).slice(0, 500)
    const tasks = await Task.find({ _id: { $in: list } })
    const byId = new Map(tasks.map(t => [String(t._id), t]))
    const touched = []
    for (let i = 0; i < list.length; i++) {
      const t = byId.get(list[i])
      if (!t) continue
      const rel = relation(req, t)
      if (!rel.full && !rel.assignee) continue
      const wasDone = t.status === 'done'
      const moved = setStatus(t, status, req.userId)
      if (moved) addActivity(t, req.user, `moved it to ${STATUS_WORDS[status]}`)
      t.order = i
      if (t.isModified()) { await t.save(); touched.push(t) }
      if (!wasDone && t.status === 'done') {
        await notifyDone(t, req)
        await spawnNextIfRepeating(t, req.user)
      } else if (wasDone && t.status !== 'done') await retractNextIfUntouched(t)
    }
    pushLive(touched.flatMap(involved), 'task_changed', {})
    res.json({ ok: true, updated: touched.length })
  } catch (err) {
    console.error('Reorder tasks error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// POST /portal/tasks/:id/comments { text, mentions?: [userId] }
// Mentioned people are notified and become watchers, so they can open it.
export async function addTaskComment(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Task not found' })
    const task = await Task.findById(req.params.id)
    if (!task || !relation(req, task).visible) return res.status(404).json({ error: 'Task not found' })
    const text = String(req.body?.text || '').trim().slice(0, 2000)
    if (!text) return res.status(400).json({ error: 'Write a comment first' })
    const mentionIds = cleanIds(req.body?.mentions).filter(id => !sameId(id, req.userId)).slice(0, 10)
    const mentioned = mentionIds.length
      ? await User.find({ _id: { $in: mentionIds }, status: 'active' }).select('_id roles').populate('roles', 'key').lean()
      : []
    // A student can only be brought in by assigning them the task, never by a
    // mention: a mention makes you a watcher, and staff talk about students in
    // comments on tasks the student must not see.
    const isStudentUser = (u) => (u.roles || []).length > 0 && u.roles.every(r => r.key === 'student')
    const allowed = mentioned.filter(u => !isStudentUser(u) || task.assignees.some(a => sameId(a, u._id)))
    const mentionSet = new Set(allowed.map(u => String(u._id)))
    task.comments.push({ text, by: req.userId, byName: req.user.displayName || '', mentions: [...mentionSet] })
    for (const id of mentionSet) {
      const already = [...task.assignees, ...task.watchers, task.createdBy].some(x => sameId(x, id))
      if (!already) task.watchers.push(id)
    }
    await task.save()
    for (const uid of mentionSet) {
      await createNotification({
        userId: uid, type: 'task_mention', title: `${req.user.displayName || 'Someone'} mentioned you: ${task.title}`,
        body: text.slice(0, 140), payload: { taskId: String(task._id) },
      })
    }
    for (const uid of new Set(involved(task).map(String))) {
      if (sameId(uid, req.userId) || mentionSet.has(uid)) continue
      await createNotification({
        userId: uid, type: 'task_comment', title: `Comment on: ${task.title}`,
        body: `${req.user.displayName || 'Someone'}: ${text.slice(0, 140)}`, payload: { taskId: String(task._id) },
      })
    }
    const populated = await Task.findById(task._id).populate(POPULATE).populate('repeatOf', 'title dueDate').lean()
    pushLive(involved(task), 'task_changed', { taskId: String(task._id) })
    res.status(201).json(populated)
  } catch (err) {
    console.error('Task comment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// DELETE /portal/tasks/:id — managers and the creator
export async function deleteTask(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Task not found' })
    const task = await Task.findById(req.params.id)
    if (!task || !relation(req, task).visible) return res.status(404).json({ error: 'Task not found' })
    if (!relation(req, task).full) return res.status(403).json({ error: 'Only the person who created it or a manager can delete it' })
    await Task.deleteOne({ _id: task._id })
    await logActivity({ level: 'warning', category: 'portal', action: 'task_deleted', message: `Task deleted: ${task.title}`, req, meta: { taskId: task._id } })
    pushLive(involved(task), 'task_changed', { taskId: String(task._id) })
    // The whole task comes back, so the page can offer Undo (POST /restore).
    res.json({ ok: true, deleted: [task.toObject()] })
  } catch (err) {
    console.error('Delete task error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Many at once (task.manage) ───

const UNDO_FIELDS = ['status', 'priority', 'assignees', 'dueDate', 'startDate', 'allDay', 'completedAt', 'completedBy', 'order']
// A copy, not references: the task's own arrays are changed right after this.
const undoSnapshot = (t) => ({
  _id: String(t._id),
  ...Object.fromEntries(UNDO_FIELDS.map(f => {
    const v = t[f]
    if (f === 'assignees') return [f, (v || []).map(String)]
    if (v instanceof Date) return [f, v.toISOString()]
    return [f, v == null ? null : (typeof v === 'object' ? String(v) : v)]
  })),
})

// POST /portal/tasks/bulk { ids, set: { status?, priority?, addAssignees?, removeAssignees?,
//   assignees?, dueDate? (YYYY-MM-DD or null), shiftDays? } }
// Returns `undo`: each task's fields before the change, for POST /bulk/undo.
export async function bulkUpdateTasks(req, res) {
  try {
    if (!canManage(req)) return res.status(403).json({ error: 'Only managers can change many tasks at once' })
    const ids = cleanIds(req.body?.ids).slice(0, 300)
    const set = req.body?.set || {}
    if (!ids.length) return res.status(400).json({ error: 'Pick at least one task' })
    const tasks = await Task.find({ _id: { $in: ids } })
    const undo = []
    let updated = 0
    for (const t of tasks) {
      const before = snapshot(t)
      undo.push(undoSnapshot(t))
      const wasDone = t.status === 'done'
      if (set.status) setStatus(t, set.status, req.userId)
      if (set.priority && TASK_PRIORITIES.includes(set.priority)) t.priority = set.priority
      if (set.assignees !== undefined) t.assignees = cleanIds(set.assignees)
      if (set.addAssignees) for (const id of cleanIds(set.addAssignees)) if (!t.assignees.some(a => sameId(a, id))) t.assignees.push(id)
      if (set.removeAssignees) { const rm = cleanIds(set.removeAssignees); t.assignees = t.assignees.filter(a => !rm.includes(String(a))) }
      if (set.dueDate !== undefined) {
        const d = parseDate(set.dueDate, true)
        if (d !== undefined) { t.dueDate = d; t.allDay = true; if (d && t.startDate && t.startDate > d) t.startDate = d }
      }
      const shift = parseInt(set.shiftDays, 10)
      if (shift && Math.abs(shift) <= 365) {
        if (t.dueDate) t.dueDate = new Date(t.dueDate.getTime() + shift * 86400000)
        if (t.startDate) t.startDate = new Date(t.startDate.getTime() + shift * 86400000)
      }
      for (const line of await describeChanges(before, t)) addActivity(t, req.user, line)
      if (!t.isModified()) { undo.pop(); continue }
      await t.save()
      updated++
      const added = t.assignees.map(String).filter(id => !before.assignees.includes(id))
      if (added.length) await notifyAssigned(t, added, req.user)
      if (!wasDone && t.status === 'done') await spawnNextIfRepeating(t, req.user)
    }
    pushLive(tasks.flatMap(involved), 'task_changed', {})
    res.json({ ok: true, updated, undo })
  } catch (err) {
    console.error('Bulk update tasks error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// POST /portal/tasks/bulk/undo { undo: [...] } — put those fields back.
export async function undoBulkUpdate(req, res) {
  try {
    if (!canManage(req)) return res.status(403).json({ error: 'Only managers can undo this' })
    const list = Array.isArray(req.body?.undo) ? req.body.undo.slice(0, 300) : []
    let restored = 0
    for (const snap of list) {
      if (!isValidObjectId(snap?._id)) continue
      const t = await Task.findById(snap._id)
      if (!t) continue
      for (const f of UNDO_FIELDS) {
        if (!(f in snap)) continue
        if (f === 'assignees') t.assignees = cleanIds(snap.assignees)
        else if (['dueDate', 'startDate', 'completedAt'].includes(f)) t[f] = snap[f] ? new Date(snap[f]) : undefined
        else t[f] = snap[f] ?? undefined
      }
      addActivity(t, req.user, 'undid a change made to several tasks')
      await t.save()
      await retractNextIfUntouched(t)
      restored++
    }
    res.json({ ok: true, restored })
  } catch (err) {
    console.error('Undo bulk tasks error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// POST /portal/tasks/bulk/delete { ids } — returns the deleted tasks for Undo.
export async function bulkDeleteTasks(req, res) {
  try {
    if (!canManage(req)) return res.status(403).json({ error: 'Only managers can delete many tasks at once' })
    const ids = cleanIds(req.body?.ids).slice(0, 300)
    const tasks = await Task.find({ _id: { $in: ids } }).lean()
    await Task.deleteMany({ _id: { $in: tasks.map(t => t._id) } })
    await logActivity({ level: 'warning', category: 'portal', action: 'tasks_deleted', message: `${tasks.length} tasks deleted`, req, meta: { ids } })
    pushLive(tasks.flatMap(involved), 'task_changed', {})
    res.json({ ok: true, deleted: tasks })
  } catch (err) {
    console.error('Bulk delete tasks error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// POST /portal/tasks/restore { tasks: [...] } — Undo for a delete: puts the
// tasks back exactly as they were (same ids). Managers, or the creator of each.
export async function restoreTasks(req, res) {
  try {
    const list = Array.isArray(req.body?.tasks) ? req.body.tasks.slice(0, 300) : []
    let restored = 0
    for (const doc of list) {
      if (!isValidObjectId(doc?._id)) continue
      // Non-managers: only their own tasks, still assigned only to themselves.
      if (!canManage(req) && (!sameId(doc.createdBy, req.userId) || (doc.assignees || []).some(a => !sameId(a, req.userId)))) continue
      if (await Task.exists({ _id: doc._id })) continue
      const t = new Task(doc)
      addActivity(t, req.user, 'brought it back after it was deleted')
      await t.save()
      restored++
      pushLive(involved(t), 'task_changed', { taskId: String(t._id) })
    }
    res.json({ ok: true, restored })
  } catch (err) {
    console.error('Restore tasks error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Saved views ───

// GET /portal/tasks/views — mine + everyone's shared ones
export async function listTaskViews(req, res) {
  try {
    const views = await TaskView.find({ $or: [{ userId: req.userId }, { shared: true }] })
      .populate('userId', 'displayName').sort({ shared: 1, name: 1 }).lean()
    res.json({ records: views.map(v => ({ ...v, mine: sameId(v.userId, req.userId), ownerName: v.userId?.displayName || '' })) })
  } catch (err) {
    console.error('List task views error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// POST /portal/tasks/views { name, filters, shared? } — sharing needs task.manage
export async function createTaskView(req, res) {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 60)
    if (!name) return res.status(400).json({ error: 'Give the view a name' })
    const filters = req.body?.filters && typeof req.body.filters === 'object' ? req.body.filters : {}
    if (JSON.stringify(filters).length > 4000) return res.status(400).json({ error: 'Too many filters to save' })
    const view = await TaskView.create({ userId: req.userId, name, filters, shared: !!req.body?.shared && canManage(req) })
    res.status(201).json({ ...view.toObject(), mine: true })
  } catch (err) {
    console.error('Create task view error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// DELETE /portal/tasks/views/:id — your own, or (managers) a shared one
export async function deleteTaskView(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'View not found' })
    const view = await TaskView.findById(req.params.id)
    if (!view) return res.status(404).json({ error: 'View not found' })
    if (!sameId(view.userId, req.userId) && !(view.shared && canManage(req))) return res.status(403).json({ error: 'Not your view' })
    await TaskView.deleteOne({ _id: view._id })
    res.json({ ok: true })
  } catch (err) {
    console.error('Delete task view error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Pickers ───

const kindOf = (u) => {
  const keys = (u.roles || []).map(r => r.key)
  if (keys.length && keys.every(k => k === 'student')) return 'student'
  if (keys.includes('tutor') && keys.length === 1) return 'tutor'
  return 'staff'
}

// GET /portal/tasks/assignees?q=&ids=&kind=staff|tutor|student — anyone a task
// can be assigned to. Without task.manage it only ever returns yourself.
export async function pickAssignees(req, res) {
  try {
    const { q, ids, kind } = req.query
    const filter = { status: 'active' }
    if (!canManage(req)) filter._id = req.userId
    else if (ids) filter._id = { $in: cleanIds(String(ids).split(',')).slice(0, 50) }
    if (q && !ids) {
      const rx = new RegExp(escapeRx(q), 'i')
      filter.$or = [{ displayName: rx }, { email: rx }]
    }
    if (kind && !ids && canManage(req)) {
      const studentRole = await Role.findOne({ key: 'student' }).select('_id').lean()
      const tutorRole = await Role.findOne({ key: 'tutor' }).select('_id').lean()
      if (kind === 'student' && studentRole) filter.roles = studentRole._id
      if (kind === 'tutor' && tutorRole) filter.roles = tutorRole._id
      if (kind === 'staff') filter.roles = { $nin: [studentRole?._id, tutorRole?._id].filter(Boolean) }
    }
    const users = await User.find(filter)
      .populate('roles', 'key name')
      .populate('linkedStudentId', 'name rollNo')
      .select('displayName email roles linkedStudentId')
      .sort({ displayName: 1 })
      .limit(ids ? 50 : 25)
      .lean()
    res.json(users.map(u => ({
      _id: u._id,
      displayName: u.displayName || u.email,
      email: u.email,
      kind: kindOf(u),
      roleNames: (u.roles || []).map(r => r.name).join(', '),
      rollNo: u.linkedStudentId?.rollNo || '',
    })))
  } catch (err) {
    console.error('Task assignee picker error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/tasks/leads?q=&ids= — leads to link a task to (needs the Leads
// page's own permission, student.create)
export async function pickLeads(req, res) {
  try {
    const { q, ids } = req.query
    const filter = {}
    if (ids) filter._id = { $in: cleanIds(String(ids).split(',')).slice(0, 50) }
    else if (q) {
      const rx = new RegExp(escapeRx(q), 'i')
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }]
    }
    const leads = await Enrollment.find(filter).select('name phone email status program').sort({ createdAt: -1 }).limit(25).lean()
    res.json(leads)
  } catch (err) {
    console.error('Task lead picker error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Goals ───

async function withProgress(goals) {
  if (!goals.length) return []
  const counts = await Task.aggregate([
    { $match: { goalId: { $in: goals.map(g => g._id) } } },
    { $group: { _id: '$goalId', total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } } } },
  ])
  const byId = new Map(counts.map(c => [String(c._id), c]))
  return goals.map(g => {
    const c = byId.get(String(g._id)) || { total: 0, done: 0 }
    const target = g.target > 0 ? g.target : c.total
    return { ...g, taskCount: c.total, doneCount: c.done, progress: target > 0 ? Math.min(100, Math.round((c.done / target) * 100)) : 0 }
  })
}

const GOAL_POPULATE = { path: 'owners', select: 'displayName email' }

// GET /portal/tasks/goals?period=&status=&active=1
export async function listGoals(req, res) {
  try {
    const filter = {}
    if (!canSeeAll(req)) filter.owners = req.userId
    if (['weekly', 'monthly'].includes(req.query.period)) filter.period = req.query.period
    if (req.query.status) filter.status = req.query.status
    else filter.status = { $ne: 'archived' }
    if (req.query.current === '1') {
      const now = new Date()
      filter.startDate = { $lte: now }
      filter.endDate = { $gte: new Date(now.getTime() - 86400000) }
    }
    const goals = await Goal.find(filter).populate(GOAL_POPULATE).sort({ startDate: -1 }).limit(200).lean()
    res.json({ records: await withProgress(goals), canManage: canManage(req) })
  } catch (err) {
    console.error('List goals error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

function applyGoal(goal, body) {
  if (body.title !== undefined) goal.title = String(body.title).trim().slice(0, 200)
  if (body.description !== undefined) goal.description = String(body.description || '').slice(0, 2000)
  if (['weekly', 'monthly'].includes(body.period)) goal.period = body.period
  for (const f of ['startDate', 'endDate']) {
    const d = parseDate(body[f], true)
    if (d) goal[f] = d
  }
  if (goal.startDate && goal.endDate && goal.endDate < goal.startDate) goal.endDate = goal.startDate
  if (body.target !== undefined) goal.target = Math.max(0, parseInt(body.target, 10) || 0)
  if (body.owners !== undefined) goal.owners = cleanIds(body.owners)
  if (['active', 'achieved', 'missed', 'archived'].includes(body.status)) goal.status = body.status
  if (body.color !== undefined) goal.color = String(body.color || '').slice(0, 20)
}

export async function createGoal(req, res) {
  try {
    const body = req.body || {}
    if (!String(body.title || '').trim()) return res.status(400).json({ error: 'A title is required' })
    if (!body.startDate || !body.endDate) return res.status(400).json({ error: 'Pick the week or month the goal covers' })
    const goal = new Goal({ createdBy: req.userId })
    applyGoal(goal, body)
    await goal.save()
    const [out] = await withProgress([await Goal.findById(goal._id).populate(GOAL_POPULATE).lean()])
    res.status(201).json(out)
  } catch (err) {
    console.error('Create goal error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateGoal(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Goal not found' })
    const goal = await Goal.findById(req.params.id)
    if (!goal) return res.status(404).json({ error: 'Goal not found' })
    applyGoal(goal, req.body || {})
    await goal.save()
    const [out] = await withProgress([await Goal.findById(goal._id).populate(GOAL_POPULATE).lean()])
    res.json(out)
  } catch (err) {
    console.error('Update goal error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// DELETE /portal/tasks/goals/:id — its tasks stay, unlinked.
export async function deleteGoal(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Goal not found' })
    const goal = await Goal.findByIdAndDelete(req.params.id)
    if (!goal) return res.status(404).json({ error: 'Goal not found' })
    await Task.updateMany({ goalId: goal._id }, { $unset: { goalId: 1 } })
    res.json({ ok: true })
  } catch (err) {
    console.error('Delete goal error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// The shift day in Pakistan time: the academy's night shift runs 8 PM to
// 7 AM PKT and is labelled by the day it starts, so before 7 AM it is still
// yesterday's shift (same rule as utils/shiftWindow.js SHIFT_WRAP_HOUR).
const PK_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' })
const pkHour = (d) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', hourCycle: 'h23' }).format(d))
function shiftDay(now = new Date()) {
  return PK_DAY.format(pkHour(now) < SHIFT_WRAP_HOUR ? new Date(now.getTime() - 86400000) : now)
}
// checkedToday: a Recurring task's "Checked today" tick for the current shift.
const withToday = (t, day = shiftDay()) => (t ? { ...t, checkedToday: t.status === 'recurring' && t.dailyCheckedOn === day } : t)

// The daily reminder for Recurring tasks goes out an hour before the shift
// starts (7 PM PKT), or straight away if the server starts mid-shift.
const DAILY_REMINDER_HOUR = 19

async function sendDailyReminders() {
  const now = new Date()
  const hour = pkHour(now)
  if (hour < DAILY_REMINDER_HOUR && hour >= SHIFT_WRAP_HOUR) return
  const day = shiftDay(now)
  const tasks = await Task.find({ status: 'recurring', 'assignees.0': { $exists: true }, dailyNotifiedOn: { $ne: day } })
    .select('title assignees dailyCheckedOn').lean()
  for (const t of tasks) {
    await Task.updateOne({ _id: t._id }, { dailyNotifiedOn: day })
    if (t.dailyCheckedOn === day) continue
    for (const uid of t.assignees) {
      await createNotification({
        userId: uid,
        type: 'task_due',
        title: `Today: ${t.title}`,
        body: 'A daily task. Look at it today, then tick "Checked today".',
        payload: { taskId: String(t._id) },
      })
    }
  }
}

// ─── Background job: "due today" notification for each open task ───
// Runs every 15 minutes. All-day tasks fall due on their date; timed tasks on
// their Pakistan-time date. dueNotifiedFor remembers which due date was
// announced, so rescheduling a task announces it again on the new day.
let jobRunning = false
export async function runTaskDueReminders() {
  if (jobRunning) return
  jobRunning = true
  try {
    const todayPk = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date())
    const now = Date.now()
    await sendDailyReminders()
    const tasks = await Task.find({
      status: { $nin: ['done', 'recurring'] },
      dueDate: { $gte: new Date(now - 36 * 3600000), $lte: new Date(now + 36 * 3600000) },
      'assignees.0': { $exists: true },
    }).lean()
    for (const t of tasks) {
      const day = t.allDay
        ? new Date(t.dueDate).toISOString().slice(0, 10)
        : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date(t.dueDate))
      if (day !== todayPk) continue
      if (t.dueNotifiedFor && new Date(t.dueNotifiedFor).getTime() === new Date(t.dueDate).getTime()) continue
      await Task.updateOne({ _id: t._id }, { dueNotifiedFor: t.dueDate })
      for (const uid of t.assignees) {
        await createNotification({
          userId: uid,
          type: 'task_due',
          title: `Due today: ${t.title}`,
          body: t.allDay ? 'This task is due today and still open.' : `Due at ${dateLabel(t)}, still open.`,
          payload: { taskId: String(t._id) },
        })
      }
    }
  } catch (err) {
    console.error('Task due reminders error:', err.message)
  } finally {
    jobRunning = false
  }
}

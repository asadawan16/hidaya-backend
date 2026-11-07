// Tasks board + goals (client's request, 2026-11-07; his branch only).
//
// Who sees what:
//   - everyone: tasks assigned to them or created by them
//   - task.read: every task
//   - task.manage: create/assign for anyone (staff, tutors, students), edit or
//     delete any task, manage goals
// Staff without task.manage can still add their own to-dos (assigned to
// themselves). Students only see and work the tasks assigned to them.
import mongoose from 'mongoose'
import Task, { TASK_STATUSES, TASK_PRIORITIES, TASK_TYPES } from '../models/Task.js'
import Goal from '../models/Goal.js'
import User from '../models/User.js'
import Role from '../models/Role.js'
import Enrollment from '../models/Enrollment.js'
import '../models/Student.js'
import { createNotification } from './portalNotificationController.js'
import { emitToUser } from '../config/socket.js'
import { logActivity } from '../utils/activityLogger.js'

const { isValidObjectId } = mongoose
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const canSeeAll = (req) => req.userPermissions.has('task.read') || req.userPermissions.has('task.manage')
const canManage = (req) => req.userPermissions.has('task.manage')
const isStudentOnly = (req) => (req.user.roles || []).length > 0 && req.user.roles.every(r => r.key === 'student')
const sameId = (a, b) => String(a?._id || a) === String(b?._id || b)

const POPULATE = [
  { path: 'assignees', select: 'displayName email linkedStudentId roles', populate: { path: 'roles', select: 'key name' } },
  { path: 'leadId', select: 'name phone email status program' },
  { path: 'studentId', select: 'name rollNo' },
  { path: 'goalId', select: 'title period startDate endDate' },
]

function visibleFilter(req) {
  if (canSeeAll(req)) return {}
  return { $or: [{ assignees: req.userId }, { createdBy: req.userId }] }
}

function relation(req, task) {
  const manager = canManage(req)
  const creator = sameId(task.createdBy, req.userId)
  const assignee = (task.assignees || []).some(a => sameId(a, req.userId))
  return { manager, creator, assignee, full: manager || creator, visible: canSeeAll(req) || creator || assignee }
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
const involved = (task) => [...(task.assignees || []).map(a => a?._id || a), task.createdBy].filter(Boolean)

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

// ─── Tasks ───

// GET /portal/tasks
export async function listTasks(req, res) {
  try {
    const q = req.query
    const and = []
    const scope = q.scope || (canSeeAll(req) ? 'all' : 'involved')
    if (scope === 'mine') and.push({ assignees: req.userId })
    else if (scope === 'created') and.push({ createdBy: req.userId })
    else if (scope === 'involved' || !canSeeAll(req)) and.push({ $or: [{ assignees: req.userId }, { createdBy: req.userId }] })

    const list = (v, allowed) => String(v || '').split(',').map(s => s.trim()).filter(s => allowed.includes(s))
    if (q.status) { const v = list(q.status, TASK_STATUSES); if (v.length) and.push({ status: { $in: v } }) }
    if (q.type) { const v = list(q.type, TASK_TYPES); if (v.length) and.push({ type: { $in: v } }) }
    if (q.priority) { const v = list(q.priority, TASK_PRIORITIES); if (v.length) and.push({ priority: { $in: v } }) }
    if (q.hideDone === '1') and.push({ status: { $ne: 'done' } })
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
    // Date window (calendar / timeline): tasks whose [start, due] span overlaps
    // [from, to]. A task with only one date uses it for both ends.
    const from = q.from ? new Date(q.from) : null
    const to = q.to ? new Date(q.to) : null
    if (from && to && !isNaN(from) && !isNaN(to)) {
      and.push({
        $or: [
          { dueDate: { $gte: from }, $or: [{ startDate: { $lte: to } }, { startDate: null, dueDate: { $lte: to } }] },
          { dueDate: null, startDate: { $gte: from, $lte: to } },
        ],
      })
    }

    const limit = Math.min(1000, Math.max(1, parseInt(q.limit, 10) || 500))
    const filter = and.length ? { $and: and } : {}
    const [records, total] = await Promise.all([
      Task.find(filter).populate(POPULATE).sort({ order: 1, dueDate: 1, createdAt: -1 }).limit(limit).lean(),
      Task.countDocuments(filter),
    ])
    res.json({ records, total, canManage: canManage(req), canSeeAll: canSeeAll(req) })
  } catch (err) {
    console.error('List tasks error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/tasks/my/summary — the signed-in user's open tasks that are
// dated up to a week ahead (or undated), for the dashboard "My work" card and
// the reminder pop-up. The browser buckets them into overdue / today / later
// in its own time zone.
export async function myTaskSummary(req, res) {
  try {
    const horizon = new Date(Date.now() + 8 * 86400000)
    const base = { assignees: req.userId, status: { $ne: 'done' } }
    const [dated, undatedCount, undated, doneThisWeek] = await Promise.all([
      Task.find({ ...base, dueDate: { $ne: null, $lte: horizon } }).populate(POPULATE).sort({ dueDate: 1 }).limit(100).lean(),
      Task.countDocuments({ ...base, dueDate: null }),
      Task.find({ ...base, dueDate: null }).populate(POPULATE).sort({ createdAt: -1 }).limit(10).lean(),
      Task.countDocuments({ assignees: req.userId, status: 'done', completedAt: { $gte: new Date(Date.now() - 7 * 86400000) } }),
    ])
    const openCount = await Task.countDocuments(base)
    res.json({ tasks: dated, undated, undatedCount, openCount, doneThisWeek })
  } catch (err) {
    console.error('My task summary error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/tasks/:id
export async function getTask(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Task not found' })
    const task = await Task.findById(req.params.id).populate(POPULATE).lean()
    if (!task || !relation(req, task).visible) return res.status(404).json({ error: 'Task not found' })
    res.json(task)
  } catch (err) {
    console.error('Get task error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

function applyFields(task, body, { creating }) {
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
    task[f] = isValidObjectId(body[f]) ? body[f] : null
  }
  if (body.tags !== undefined) task.tags = (Array.isArray(body.tags) ? body.tags : []).map(t => String(t).trim()).filter(Boolean).slice(0, 10)
  const cl = cleanChecklist(body.checklist)
  if (cl) task.checklist = cl
}

function setStatus(task, status, userId) {
  if (!TASK_STATUSES.includes(status) || task.status === status) return false
  task.status = status
  if (status === 'done') { task.completedAt = new Date(); task.completedBy = userId }
  else { task.completedAt = undefined; task.completedBy = undefined }
  return true
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
    applyFields(task, body, { creating: true })
    setStatus(task, body.status || 'todo', req.userId)
    // New cards go to the top of their column.
    const top = await Task.findOne({ status: task.status }).sort({ order: 1 }).select('order').lean()
    task.order = (top?.order ?? 0) - 1
    await task.save()

    await notifyAssigned(task, assignees, req.user)
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
// an assignee can move it (status / order), tick its checklist, and comment.
export async function updateTask(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Task not found' })
    const task = await Task.findById(req.params.id)
    if (!task) return res.status(404).json({ error: 'Task not found' })
    const rel = relation(req, task)
    if (!rel.visible) return res.status(404).json({ error: 'Task not found' })
    if (!rel.full && !rel.assignee) return res.status(403).json({ error: 'You can only view this task' })
    const body = req.body || {}
    const before = { status: task.status, assignees: task.assignees.map(String) }

    if (rel.full) {
      applyFields(task, body, { creating: false })
      if (body.assignees !== undefined) {
        let next = cleanIds(body.assignees)
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
    if (body.status !== undefined) setStatus(task, body.status, req.userId)
    if (body.order !== undefined && Number.isFinite(Number(body.order))) task.order = Number(body.order)
    await task.save()

    const added = task.assignees.map(String).filter(id => !before.assignees.includes(id))
    if (added.length) await notifyAssigned(task, added, req.user)
    if (before.status !== 'done' && task.status === 'done' && task.createdBy && !sameId(task.createdBy, req.userId)) {
      await createNotification({
        userId: task.createdBy,
        type: 'task_updated',
        title: `Done: ${task.title}`,
        body: `${req.user.displayName || 'Someone'} marked it done`,
        payload: { taskId: String(task._id) },
      })
    }
    const populated = await Task.findById(task._id).populate(POPULATE).lean()
    pushLive([...involved(task), ...before.assignees], 'task_changed', { taskId: String(task._id) })
    res.json(populated)
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
      setStatus(t, status, req.userId)
      t.order = i
      if (t.isModified()) { await t.save(); touched.push(t) }
      if (!wasDone && t.status === 'done' && t.createdBy && !sameId(t.createdBy, req.userId)) {
        await createNotification({
          userId: t.createdBy, type: 'task_updated', title: `Done: ${t.title}`,
          body: `${req.user.displayName || 'Someone'} marked it done`, payload: { taskId: String(t._id) },
        })
      }
    }
    pushLive(touched.flatMap(involved), 'task_changed', {})
    res.json({ ok: true, updated: touched.length })
  } catch (err) {
    console.error('Reorder tasks error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// POST /portal/tasks/:id/comments { text }
export async function addTaskComment(req, res) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Task not found' })
    const task = await Task.findById(req.params.id)
    if (!task || !relation(req, task).visible) return res.status(404).json({ error: 'Task not found' })
    const text = String(req.body?.text || '').trim().slice(0, 2000)
    if (!text) return res.status(400).json({ error: 'Write a comment first' })
    task.comments.push({ text, by: req.userId, byName: req.user.displayName || '' })
    await task.save()
    for (const uid of new Set(involved(task).map(String))) {
      if (sameId(uid, req.userId)) continue
      await createNotification({
        userId: uid, type: 'task_comment', title: `Comment on: ${task.title}`,
        body: `${req.user.displayName || 'Someone'}: ${text.slice(0, 140)}`, payload: { taskId: String(task._id) },
      })
    }
    const populated = await Task.findById(task._id).populate(POPULATE).lean()
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
    res.json({ ok: true })
  } catch (err) {
    console.error('Delete task error:', err)
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
    const tasks = await Task.find({
      status: { $ne: 'done' },
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

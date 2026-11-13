/*
 * English Coach — the Levels and Assigned tests tabs. The rules (how a level
 * is passed, how an assignment completes) live in services/coachProgress.js.
 *
 *   GET  /levels                 the ladder, for the editor (coach.review reads, coach.manage edits)
 *   PUT  /levels                 save the whole ladder (coach.manage)
 *   GET  /levels/team            everyone who can practise and their level (coach.review)
 *   GET  /practisers             people a test can be given to (coach.review)
 *   GET  /assignments            assigned tests, newest first (coach.review)
 *   POST /assignments            give a test to one or more people (coach.review)
 *   DELETE /assignments/:assignmentId
 */
import mongoose from 'mongoose'
import CoachSettings from '../models/CoachSettings.js'
import CoachAssignment from '../models/CoachAssignment.js'
import User from '../models/User.js'
import Task from '../models/Task.js'
import { DIFFICULTIES, ALLOWED_DURATIONS, groupOf, isScripted } from '../config/coachScenarios.js'
import { allScenarios } from '../services/coachScripts.js'
import {
  cleanTestSpec, levelProgress, practiserFilter, cannotPractise, cannotPractiseMessage, syncTaskTests,
  MAX_LEVELS, MAX_LEVEL_ITEMS,
} from '../services/coachProgress.js'
import { createNotification } from './portalNotificationController.js'
import { emitToUser } from '../config/socket.js'
import { logActivity } from '../utils/activityLogger.js'

const { isValidObjectId } = mongoose
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const userView = (u) => (u && u._id ? { id: u._id, name: u.displayName || u.email || 'Unknown', email: u.email } : null)
const fail = (res, err, where) => {
  console.error(`English Coach ${where}:`, err)
  res.status(500).json({ error: 'Server error' })
}

/** Scenarios and scripts as the editors need them (disabled ones too). */
const pickable = (scenarios) => scenarios.map(s => ({
  key: s.key, title: s.title, group: groupOf(s), kind: isScripted(s) ? 'script' : 'conversation',
}))

function levelsView(levels, scenarios) {
  const byKey = new Map(scenarios.map(s => [s.key, s]))
  return levels.map((l, i) => ({
    id: l._id,
    number: i + 1,
    title: l.title,
    note: l.note,
    items: l.items.map(it => {
      const sc = byKey.get(it.scenarioKey)
      return {
        id: it._id,
        scenarioKey: it.scenarioKey,
        scenarioTitle: sc?.title || 'A deleted script',
        kind: sc ? (isScripted(sc) ? 'script' : 'conversation') : 'missing',
        difficulty: it.difficulty,
        durationMin: it.durationMin ?? null,
        passScore: it.passScore,
      }
    }),
  }))
}

// ── Levels ───────────────────────────────────────────────────────────────────
export async function getLevels(req, res) {
  try {
    const settings = await CoachSettings.getSettings()
    const scenarios = await allScenarios(settings.scriptMode)
    res.json({
      levels: levelsView(settings.levels, scenarios),
      updatedAt: settings.levelsUpdatedAt || null,
      scenarios: pickable(scenarios),
      difficulties: Object.fromEntries(Object.entries(DIFFICULTIES).map(([k, v]) => [k, { label: v.label }])),
      durations: ALLOWED_DURATIONS,
      limits: { levels: MAX_LEVELS, items: MAX_LEVEL_ITEMS },
    })
  } catch (err) { fail(res, err, 'levels') }
}

/**
 * PUT /levels { levels: [{ id?, title, note, items: [{ id?, scenarioKey,
 * difficulty, durationMin, passScore }] }] } — the whole ladder, in order.
 * An item keeps its id (and so the calls already taken for it) when the
 * request sends it back.
 */
export async function saveLevels(req, res) {
  try {
    const list = req.body?.levels
    if (!Array.isArray(list)) return res.status(400).json({ error: 'Send the levels as a list.' })
    if (list.length > MAX_LEVELS) return res.status(400).json({ error: `Up to ${MAX_LEVELS} levels.` })
    const settings = await CoachSettings.getSettings()
    const scenarios = await allScenarios(settings.scriptMode)
    const known = new Set()
    for (const l of settings.levels) {
      known.add(String(l._id))
      for (const it of l.items) known.add(String(it._id))
    }
    const keep = (id) => (isValidObjectId(id) && known.has(String(id)) ? id : undefined)
    const used = new Set()
    const levels = []
    for (let i = 0; i < list.length; i++) {
      const l = list[i] || {}
      const n = i + 1
      const items = Array.isArray(l.items) ? l.items : []
      if (!items.length) return res.status(400).json({ error: `Level ${n} has no tests. Add one, or remove the level.` })
      if (items.length > MAX_LEVEL_ITEMS) return res.status(400).json({ error: `Level ${n} has more than ${MAX_LEVEL_ITEMS} tests.` })
      const seen = new Set()
      const clean = []
      for (const it of items) {
        const { spec, error } = cleanTestSpec(it, scenarios, { defaultPass: 60 })
        if (error) return res.status(400).json({ error: `Level ${n}: ${error}` })
        const pair = `${spec.scenarioKey}:${spec.difficulty}`
        if (seen.has(pair)) return res.status(400).json({ error: `Level ${n} has "${spec.scenarioTitle}" at ${DIFFICULTIES[spec.difficulty].label} twice.` })
        seen.add(pair)
        // An id sent twice (a copied item) makes a new one the second time
        const id = keep(it.id)
        const _id = id && !used.has(String(id)) ? id : undefined
        if (_id) used.add(String(_id))
        clean.push({ ...(_id && { _id }), scenarioKey: spec.scenarioKey, difficulty: spec.difficulty, durationMin: spec.durationMin, passScore: spec.passScore })
      }
      const lid = keep(l.id)
      const _id = lid && !used.has(String(lid)) ? lid : undefined
      if (_id) used.add(String(_id))
      levels.push({
        ...(_id && { _id }),
        title: String(l.title || '').trim().slice(0, 80),
        note: String(l.note || '').trim().slice(0, 300),
        items: clean,
      })
    }
    settings.levels = levels
    settings.levelsUpdatedAt = new Date()
    settings.updatedBy = req.userId
    await settings.save()
    logActivity({
      category: 'portal', action: 'english_coach_levels', req,
      message: `Saved the English Coach levels (${levels.length} level${levels.length === 1 ? '' : 's'})`,
      meta: { levels: levels.length, tests: levels.reduce((n, l) => n + l.items.length, 0) },
    })
    res.json({
      levels: levelsView(settings.levels, scenarios),
      updatedAt: settings.levelsUpdatedAt,
      scenarios: pickable(scenarios),
      difficulties: Object.fromEntries(Object.entries(DIFFICULTIES).map(([k, v]) => [k, { label: v.label }])),
      durations: ALLOWED_DURATIONS,
      limits: { levels: MAX_LEVELS, items: MAX_LEVEL_ITEMS },
    })
  } catch (err) { fail(res, err, 'levels save') }
}

/** GET /levels/team?q= — everyone who can practise, with their level. */
export async function levelTeam(req, res) {
  try {
    const settings = await CoachSettings.getSettings()
    const filter = await practiserFilter()
    const term = String(req.query.q || '').trim().slice(0, 60)
    if (term) {
      const re = new RegExp(escapeRx(term), 'i')
      filter.$or = [{ displayName: re }, { email: re }]
    }
    const users = await User.find(filter).select('displayName email').sort({ displayName: 1 }).limit(500).lean()
    const progress = await levelProgress(users.map(u => u._id), settings.levels)
    const people = users.map(u => {
      const p = progress.get(String(u._id))
      const cur = p.current ? p.levels[p.current - 1] : null
      return {
        user: userView(u),
        completed: p.completed,
        current: p.current,
        finished: p.finished,
        // The level being worked on: how many of its tests are passed
        currentPassed: cur?.passedItems ?? 0,
        currentTotal: cur?.items.length ?? 0,
        lastAt: p.levels.flatMap(l => l.items.map(i => i.lastAt)).filter(Boolean).sort((a, b) => b - a)[0] || null,
        levels: p.levels.map(l => ({ number: l.number, state: l.state, items: l.items.map(i => ({ id: i.id, best: i.best, passed: i.passed, tests: i.tests, bestSessionId: i.bestSessionId })) })),
      }
    })
    // How many people stand on each level (0 = not started any level test, total+1 = finished)
    const spread = Array.from({ length: settings.levels.length }, (_, i) => ({ level: i + 1, people: people.filter(p => p.current === i + 1).length }))
    res.json({
      total: settings.levels.length,
      people,
      spread,
      finished: people.filter(p => p.finished).length,
    })
  } catch (err) { fail(res, err, 'level team') }
}

// ── People ───────────────────────────────────────────────────────────────────
/** GET /practisers?q= — who a test can be given to (active, with coach.practice). */
export async function listPractisers(req, res) {
  try {
    const filter = await practiserFilter()
    const term = String(req.query.q || '').trim().slice(0, 60)
    if (term) {
      const re = new RegExp(escapeRx(term), 'i')
      filter.$or = [{ displayName: re }, { email: re }]
    }
    const users = await User.find(filter).select('displayName email').sort({ displayName: 1 }).limit(term ? 30 : 300).lean()
    res.json({ items: users.map(userView) })
  } catch (err) { fail(res, err, 'practisers') }
}

// ── Assigned tests ───────────────────────────────────────────────────────────
function assignmentView(a) {
  return {
    id: a._id,
    status: a.status,
    user: userView(a.userId),
    scenarioKey: a.scenarioKey,
    scenarioTitle: a.scenarioTitle,
    difficulty: a.difficulty,
    durationMin: a.durationMin ?? null,
    passScore: a.passScore || 0,
    dueAt: a.dueAt || null,
    overdue: a.status === 'pending' && a.dueAt ? new Date(a.dueAt) < new Date() : false,
    note: a.note || '',
    attempts: a.attempts || 0,
    bestScore: a.bestScore ?? null,
    score: a.score ?? null,
    lastSessionId: a.lastSessionId || null,
    sessionId: a.sessionId || null,
    completedAt: a.completedAt || null,
    taskId: a.taskId || null,
    assignedByName: a.assignedByName || '',
    createdAt: a.createdAt,
  }
}

export async function listAssignments(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25))
    const q = {}
    if (['pending', 'completed'].includes(req.query.status)) q.status = req.query.status
    if (req.query.status === 'overdue') Object.assign(q, { status: 'pending', dueAt: { $lt: new Date() } })
    if (isValidObjectId(req.query.userId)) q.userId = req.query.userId
    const term = String(req.query.q || '').trim().slice(0, 60)
    if (term) {
      const re = new RegExp(escapeRx(term), 'i')
      const users = await User.find({ $or: [{ displayName: re }, { email: re }] }).select('_id').limit(200).lean()
      q.$or = [{ userId: { $in: users.map(u => u._id) } }, { scenarioTitle: re }]
    }
    const [items, total, counts] = await Promise.all([
      CoachAssignment.find(q).populate('userId', 'displayName email')
        .sort({ status: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      CoachAssignment.countDocuments(q),
      CoachAssignment.aggregate([
        { $group: { _id: null, pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } }, completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } }, overdue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'pending'] }, { $eq: [{ $type: '$dueAt' }, 'date'] }, { $lt: ['$dueAt', new Date()] }] }, 1, 0] } } } },
      ]),
    ])
    const c = counts[0] || {}
    res.json({
      items: items.map(assignmentView), total, page, pages: Math.max(1, Math.ceil(total / limit)),
      counts: { pending: c.pending || 0, completed: c.completed || 0, overdue: c.overdue || 0 },
    })
  } catch (err) { fail(res, err, 'assignments') }
}

const parseDue = (v) => {
  if (v === undefined || v === null || v === '') return undefined
  // 'YYYY-MM-DD' = the end of that day in Pakistan
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(`${v}T23:59:59.000+05:00`) : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * POST /assignments { userIds, scenarioKey, difficulty, durationMin?, passScore?,
 * dueAt?, note?, addTask? } — one assignment per person. With `addTask`, each
 * person also gets a task on the Tasks board ("English test: …") that moves to
 * Done when they pass; the task's own notification replaces ours.
 */
export async function createAssignments(req, res) {
  try {
    const b = req.body || {}
    const userIds = [...new Set((Array.isArray(b.userIds) ? b.userIds : []).map(String))].filter(isValidObjectId).slice(0, 200)
    if (!userIds.length) return res.status(400).json({ error: 'Choose who should take the test.' })
    if (b.addTask && !['task.create', 'task.manage'].some(p => req.userPermissions.has(p))) return res.status(403).json({ error: 'Only people who can create tasks can add tests to the Tasks board.' })
    const settings = await CoachSettings.getSettings()
    const { spec, error } = cleanTestSpec(b, await allScenarios(settings.scriptMode))
    if (error) return res.status(400).json({ error })
    const dueAt = parseDue(b.dueAt)
    if (dueAt === null) return res.status(400).json({ error: 'That due date is not a date.' })
    const blocked = await cannotPractise(userIds)
    if (blocked.length) return res.status(400).json({ code: 'cannot_practise', people: blocked, error: cannotPractiseMessage(blocked) })
    const note = String(b.note || '').trim().slice(0, 500)
    const by = { assignedBy: req.userId, assignedByName: req.user.displayName || req.user.email || '' }
    const label = DIFFICULTIES[spec.difficulty].label

    const made = []
    for (const uid of userIds) {
      if (b.addTask) {
        const top = await Task.findOne({ status: 'todo' }).sort({ order: 1 }).select('order').lean()
        const task = new Task({
          title: `English test: ${spec.scenarioTitle}`.slice(0, 200),
          description: [`Take this test on the English Coach page, at ${label}.${spec.passScore ? ` Pass mark: ${spec.passScore}.` : ''} The task finishes itself when you pass.`, note].filter(Boolean).join('\n\n'),
          type: 'test',
          status: 'todo',
          dueDate: dueAt ? new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(dueAt)}T00:00:00.000Z`) : undefined,
          allDay: true,
          assignees: [uid],
          coachTest: spec,
          createdBy: req.userId,
          createdByName: req.user.displayName || '',
          order: (top?.order ?? 0) - 1,
          activity: [{ text: 'created it with an English test', by: req.userId, byName: req.user.displayName || '' }],
        })
        await task.save()
        const [a] = await syncTaskTests(task)
        if (a) {
          a.note = note
          if (dueAt) a.dueAt = dueAt
          await a.save()
          made.push(a)
        }
        if (String(uid) !== String(req.userId)) {
          await createNotification({
            userId: uid, type: 'task_assigned', title: `New task: ${task.title}`,
            body: `from ${req.user.displayName || 'the office'}`, payload: { taskId: String(task._id) },
          })
        }
        emitToUser(String(uid), 'task_changed', { taskId: String(task._id) })
      } else {
        const a = await CoachAssignment.create({ userId: uid, ...spec, dueAt, note, ...by })
        made.push(a)
        if (String(uid) !== String(req.userId)) {
          await createNotification({
            userId: uid, type: 'coach_assigned', title: `English test: ${spec.scenarioTitle}`,
            body: [`${label}${spec.passScore ? ` · pass mark ${spec.passScore}` : ''}`, dueAt ? `due ${dueAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Karachi' })}` : '', `from ${by.assignedByName || 'the office'}`].filter(Boolean).join(' · '),
            payload: { assignmentId: String(a._id) },
          })
        }
      }
    }
    logActivity({
      category: 'portal', action: 'english_coach_assign', req,
      message: `Assigned the English test "${spec.scenarioTitle}" to ${made.length} ${made.length === 1 ? 'person' : 'people'}`,
      meta: { scenarioKey: spec.scenarioKey, difficulty: spec.difficulty, people: made.length, withTasks: Boolean(b.addTask) },
    })
    const items = await CoachAssignment.find({ _id: { $in: made.map(a => a._id) } }).populate('userId', 'displayName email').lean()
    res.status(201).json({ items: items.map(assignmentView) })
  } catch (err) { fail(res, err, 'assign') }
}

export async function deleteAssignment(req, res) {
  try {
    if (!isValidObjectId(req.params.assignmentId)) return res.status(404).json({ error: 'Assigned test not found' })
    const a = await CoachAssignment.findById(req.params.assignmentId)
    if (!a) return res.status(404).json({ error: 'Assigned test not found' })
    if (a.taskId && await Task.exists({ _id: a.taskId })) {
      return res.status(409).json({ code: 'on_task', taskId: a.taskId, error: 'This test belongs to a task. Remove it from the task (or delete the task) on the Tasks board.' })
    }
    await a.deleteOne()
    logActivity({ category: 'portal', action: 'english_coach_unassign', req, message: `Removed an assigned English test (${a.scenarioTitle})`, meta: { assignmentId: String(a._id) } })
    res.json({ ok: true })
  } catch (err) { fail(res, err, 'unassign') }
}

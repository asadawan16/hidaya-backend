/*
 * English Coach — levels and assigned tests.
 *
 * Levels (CoachSettings.levels, edited on the Levels tab): Level 1 is the
 * first entry. Each level is a few tests — a scenario or script at a fixed
 * difficulty, with a pass mark. A tester takes a level test from their
 * Practice tab (the call carries `levelItemId`), and a level is complete when
 * every test in it has been passed at least once. Levels open in order: the
 * server refuses a test from a level above the tester's current one.
 *
 * Progress is worked out from the calls every time, never stored. A call only
 * counts for an item while the item still names the same scenario and
 * difficulty, and the CURRENT pass mark is applied, so an admin can retune the
 * ladder and everyone's level simply follows.
 *
 * Assigned tests (models/CoachAssignment.js) are completed by the first call
 * started for them that reaches their pass mark. A task with an English test
 * (Task.coachTest) holds one assignment per assignee, kept in step by
 * syncTaskTests, and goes to Done when the last of them passes.
 */
import mongoose from 'mongoose'
import CoachSession from '../models/CoachSession.js'
import CoachSettings from '../models/CoachSettings.js'
import CoachAssignment from '../models/CoachAssignment.js'
import Role from '../models/Role.js'
import User from '../models/User.js'
import { DIFFICULTIES, ALLOWED_DURATIONS } from '../config/coachScenarios.js'
import { createNotification } from '../controllers/portalNotificationController.js'

export const MAX_LEVELS = 20
export const MAX_LEVEL_ITEMS = 10
const { isValidObjectId } = mongoose
const sameId = (a, b) => String(a?._id || a) === String(b?._id || b)

/**
 * A test's settings from a request: { scenarioKey, difficulty, durationMin,
 * passScore }. `scenarios` is every scenario and script (disabled ones too —
 * an admin may set a test on a part tutors can't pick freely).
 * Returns { spec } or { error }.
 */
export function cleanTestSpec(body, scenarios, { defaultPass = 0 } = {}) {
  const b = body || {}
  const sc = scenarios.find(s => s.key === b.scenarioKey)
  if (!sc) return { error: 'Choose a script or scenario for the test.' }
  if (!DIFFICULTIES[b.difficulty]) return { error: 'Choose the difficulty the test is taken at.' }
  let durationMin
  if (b.durationMin !== undefined && b.durationMin !== null && b.durationMin !== '') {
    durationMin = Number(b.durationMin)
    if (!ALLOWED_DURATIONS.includes(durationMin)) return { error: `The call length must be ${ALLOWED_DURATIONS.join(', ')} minutes, or left to the tester.` }
  }
  let passScore = defaultPass
  if (b.passScore !== undefined && b.passScore !== null && b.passScore !== '') {
    passScore = Number(b.passScore)
    if (!Number.isInteger(passScore) || passScore < 0 || passScore > 100) return { error: 'The pass mark must be a whole number from 0 to 100.' }
  }
  return { spec: { scenarioKey: sc.key, scenarioTitle: sc.title, difficulty: b.difficulty, durationMin, passScore }, scenario: sc }
}

/** The level and item an id points at: { level, index, item } or null. */
export function findLevelItem(levels, itemId) {
  if (!itemId) return null
  for (let index = 0; index < (levels || []).length; index++) {
    const item = levels[index].items.find(i => sameId(i._id, itemId))
    if (item) return { level: levels[index], index, item }
  }
  return null
}

/**
 * Each person's place on the ladder. Returns Map(userId → {
 *   total, completed (levels done in order), current (1-based level being
 *   worked on, null when finished or there are no levels), finished,
 *   levels: [{ id, number, state: done|current|locked, complete, passedItems,
 *              items: [{ id, best, tests, passed, bestSessionId, lastAt }] }]
 * })
 */
export async function levelProgress(userIds, levels) {
  const out = new Map()
  const ids = [...new Set(userIds.map(String))].filter(isValidObjectId)
  const items = new Map()
  for (const l of levels || []) for (const it of l.items) items.set(String(it._id), it)

  const best = new Map() // `${user}:${item}` → row
  if (ids.length && items.size) {
    const rows = await CoachSession.aggregate([
      {
        $match: {
          userId: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) },
          levelItemId: { $in: [...items.keys()].map(id => new mongoose.Types.ObjectId(id)) },
          status: 'scored',
        },
      },
      { $sort: { 'result.overall': -1, createdAt: -1 } },
      {
        $group: {
          _id: { u: '$userId', i: '$levelItemId', k: '$scenarioKey', d: '$difficulty' },
          best: { $max: '$result.overall' },
          bestSessionId: { $first: '$_id' },
          tests: { $sum: 1 },
          lastAt: { $max: '$createdAt' },
        },
      },
    ])
    for (const r of rows) {
      const it = items.get(String(r._id.i))
      // A call taken before the item changed scenario or difficulty no longer counts
      if (!it || it.scenarioKey !== r._id.k || it.difficulty !== r._id.d) continue
      best.set(`${r._id.u}:${r._id.i}`, r)
    }
  }

  for (const uid of ids) {
    const lv = (levels || []).map((l, idx) => {
      const its = l.items.map(it => {
        const r = best.get(`${uid}:${it._id}`)
        const score = r?.best ?? null
        return {
          id: it._id,
          best: score,
          tests: r?.tests || 0,
          passed: score != null && score >= it.passScore,
          bestSessionId: r?.bestSessionId || null,
          lastAt: r?.lastAt || null,
        }
      })
      return {
        id: l._id,
        number: idx + 1,
        complete: its.length > 0 && its.every(i => i.passed),
        passedItems: its.filter(i => i.passed).length,
        items: its,
      }
    })
    const open = lv.findIndex(l => !l.complete)
    const completed = open === -1 ? lv.length : open
    for (const l of lv) l.state = l.number - 1 < completed ? 'done' : l.number - 1 === completed ? 'current' : 'locked'
    out.set(uid, {
      total: lv.length,
      completed,
      current: completed < lv.length ? completed + 1 : null,
      finished: lv.length > 0 && completed === lv.length,
      levels: lv,
    })
  }
  return out
}

// ── Who can practise ────────────────────────────────────────────────────────
/** A Mongo filter for active people whose role lets them take English tests. */
export async function practiserFilter() {
  const roles = await Role.find({ permissions: 'coach.practice' }).select('_id').lean()
  return { roles: { $in: roles.map(r => r._id) }, status: 'active' }
}

/** The people in `userIds` who can't take a test — [{ id, name }]. */
export async function cannotPractise(userIds) {
  const ids = [...new Set(userIds.map(String))].filter(isValidObjectId)
  if (!ids.length) return []
  const able = await User.find({ _id: { $in: ids }, ...(await practiserFilter()) }).select('_id').lean()
  const ok = new Set(able.map(u => String(u._id)))
  const missing = ids.filter(id => !ok.has(id))
  if (!missing.length) return []
  const users = await User.find({ _id: { $in: missing } }).select('displayName email').lean()
  return missing.map(id => {
    const u = users.find(x => sameId(x._id, id))
    return { id, name: u?.displayName || u?.email || 'Unknown' }
  })
}

export function cannotPractiseMessage(list) {
  const names = list.map(p => p.name)
  const who = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')
  return `${who} can't take English tests yet. Give their role the English Coach "Practice" permission on the Roles page first.`
}

async function managerIds(exceptId) {
  const roles = await Role.find({ permissions: 'coach.manage' }).select('_id').lean()
  if (!roles.length) return []
  const users = await User.find({ roles: { $in: roles.map(r => r._id) }, status: 'active' }).select('_id').lean()
  return users.map(u => u._id).filter(id => !sameId(id, exceptId))
}

// ── Tasks ↔ assignments ─────────────────────────────────────────────────────
/**
 * Keep a task's English test and its assignments in step: one assignment per
 * assignee while the task has a test; a pending one is updated when the test
 * changes and removed when its person leaves the task (or the test is taken
 * off). A completed one is history and is left alone. Returns the
 * assignments created.
 */
export async function syncTaskTests(task) {
  const spec = task.coachTest?.scenarioKey ? task.coachTest : null
  const existing = await CoachAssignment.find({ taskId: task._id })
  if (!spec) {
    await CoachAssignment.deleteMany({ taskId: task._id, status: 'pending' })
    return []
  }
  const people = (task.assignees || []).map(a => String(a._id || a))
  for (const a of existing) {
    if (a.status === 'pending' && !people.includes(String(a.userId))) await a.deleteOne()
  }
  const fields = {
    scenarioKey: spec.scenarioKey,
    scenarioTitle: spec.scenarioTitle,
    difficulty: spec.difficulty,
    durationMin: spec.durationMin ?? undefined,
    passScore: spec.passScore ?? 0,
    dueAt: task.dueDate || undefined,
  }
  const created = []
  for (const uid of people) {
    const a = existing.find(x => sameId(x.userId, uid))
    if (!a) {
      try {
        created.push(await CoachAssignment.create({
          userId: uid, ...fields, taskId: task._id,
          assignedBy: task.createdBy, assignedByName: task.createdByName || '',
          note: '',
        }))
      } catch (err) {
        if (err?.code !== 11000) throw err // made by a save running at the same time
      }
    } else if (a.status === 'pending') {
      a.set(fields)
      if (!fields.durationMin) a.durationMin = undefined
      if (!fields.dueAt) a.dueAt = undefined
      if (a.isModified()) await a.save()
    }
  }
  return created
}

/** A task was deleted: its unfinished tests go, finished ones stay as history. */
export async function dropTaskTests(taskIds) {
  const ids = taskIds.map(String).filter(isValidObjectId)
  if (!ids.length) return
  await CoachAssignment.deleteMany({ taskId: { $in: ids }, status: 'pending' })
  await CoachAssignment.updateMany({ taskId: { $in: ids } }, { $unset: { taskId: 1 } })
}

/** Is any assignee of this task still to pass its test? */
export const taskTestPending = (taskId) => CoachAssignment.exists({ taskId, status: 'pending' })

// ── After a call is marked ──────────────────────────────────────────────────
/** Called once when a call's scorecard is saved (portalCoachController#scoreSession). */
export async function onSessionScored(s) {
  try {
    if (s.assignmentId) await assignmentScored(s)
    if (s.levelItemId) await levelScored(s)
  } catch (err) {
    console.error('English Coach progress update failed:', err.message)
  }
}

async function assignmentScored(s) {
  const score = s.result?.overall
  if (!Number.isFinite(score)) return
  const a = await CoachAssignment.findOne({ _id: s.assignmentId, userId: s.userId }).lean()
  if (!a || a.status !== 'pending' || a.scenarioKey !== s.scenarioKey || a.difficulty !== s.difficulty) return
  const passed = score >= (a.passScore || 0)
  const now = new Date()
  const done = await CoachAssignment.findOneAndUpdate(
    { _id: a._id, status: 'pending' },
    {
      $inc: { attempts: 1 },
      $max: { bestScore: score },
      $set: {
        lastSessionId: s._id, lastAttemptAt: now,
        ...(passed && { status: 'completed', completedAt: now, sessionId: s._id, score }),
      },
    },
    { new: true },
  )
  if (!done || !passed) return

  const user = await User.findById(s.userId).select('displayName email').lean()
  const name = user?.displayName || user?.email || 'A tutor'
  const label = DIFFICULTIES[a.difficulty]?.label || a.difficulty
  if (a.assignedBy && !sameId(a.assignedBy, s.userId)) {
    await createNotification({
      userId: a.assignedBy,
      type: 'coach_completed',
      title: `${name} passed an English test`,
      body: `${a.scenarioTitle || s.scenario?.title} · ${label} · ${score}/100${a.passScore ? ` (pass mark ${a.passScore})` : ''}`,
      payload: { sessionId: String(s._id), assignmentId: String(a._id), ...(a.taskId && { taskId: String(a.taskId) }) },
    })
  }
  if (done.taskId) {
    // Imported here, not at the top: the task controller imports this file
    const { completeTaskFromTest } = await import('../controllers/portalTaskController.js')
    await completeTaskFromTest(done.taskId, { userId: s.userId, name, score, last: !(await taskTestPending(done.taskId)) })
  }
}

async function levelScored(s) {
  const score = s.result?.overall
  if (!Number.isFinite(score)) return
  const settings = await CoachSettings.getSettings()
  const found = findLevelItem(settings.levels, s.levelItemId)
  if (!found || found.item.scenarioKey !== s.scenarioKey || found.item.difficulty !== s.difficulty) return
  if (score < found.item.passScore) return
  // Only the call that first passes this test can complete its level
  const before = await CoachSession.exists({
    _id: { $ne: s._id }, userId: s.userId, levelItemId: s.levelItemId,
    scenarioKey: s.scenarioKey, difficulty: s.difficulty, status: 'scored',
    'result.overall': { $gte: found.item.passScore },
  })
  if (before) return
  const progress = (await levelProgress([s.userId], settings.levels)).get(String(s.userId))
  const level = progress?.levels[found.index]
  if (!level?.complete) return

  const n = found.index + 1
  const named = found.level.title ? `Level ${n} · ${found.level.title}` : `Level ${n}`
  await createNotification({
    userId: s.userId,
    type: 'coach_level',
    title: progress.finished ? 'You have passed every English level' : `${named} complete`,
    body: progress.finished ? `All ${progress.total} levels done. Well done!` : `Level ${progress.current} is now open on your Practice tab.`,
    payload: { level: n },
  })
  const user = await User.findById(s.userId).select('displayName email').lean()
  const name = user?.displayName || user?.email || 'A tutor'
  for (const id of await managerIds(s.userId)) {
    await createNotification({
      userId: id,
      type: 'coach_level',
      title: `${name} completed English ${named}`,
      body: progress.finished ? `That was the last level (${progress.total} of ${progress.total}).` : `Now on Level ${progress.current} of ${progress.total}.`,
      payload: { level: n, userId: String(s.userId) },
    })
  }
}

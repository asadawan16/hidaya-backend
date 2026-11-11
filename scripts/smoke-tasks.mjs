// Smoke test for the Tasks board (ported from the client/myfuturecampus
// branch, Nov 2026): permissions and who sees what, notifications, reorder,
// goals, the due-today job, repeats, waiting on, mentions, bulk changes with
// undo, restore, saved views, the Recurring column, and lead task counts.
//
// Runs against a THROWAWAY database (dbName hidaya_smoke_tasks) on the
// cluster MONGODB_URI names, and drops it afterwards. No running server needed.
//   node scripts/smoke-tasks.mjs
import 'dotenv/config'
import mongoose from 'mongoose'

const SMOKE_DB = 'hidaya_smoke_tasks'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB, serverSelectionTimeoutMS: 8000 })
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}

const { default: Role } = await import('../models/Role.js')
const { default: User } = await import('../models/User.js')
const { default: Student } = await import('../models/Student.js')
const { default: Notification } = await import('../models/Notification.js')
const { default: Task } = await import('../models/Task.js')
const { default: Enrollment } = await import('../models/Enrollment.js')
const tasks = await import('../controllers/portalTaskController.js')
const leads = await import('../controllers/portalLeadsController.js')

// Today in Karachi as { iso: 'YYYY-MM-DD' }, and whole days added to an ISO date.
const karachiToday = () => ({ iso: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()) })
const addDaysIso = (iso, n) => { const d = new Date(`${iso}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }
const mockRes = () => { const r = { _status: 200, _json: null }; r.status = (c) => { r._status = c; return r }; r.json = (d) => { r._json = d; return r }; return r }
const call = async (fn, req) => { const r = mockRes(); await fn(req, r); return r }
const reqAs = (user, perms, { body = {}, query = {}, params = {} } = {}) => ({
  userId: user._id, user, userPermissions: new Set(perms), body, query, params, headers: {}, ip: '127.0.0.1',
})

try {
  await mongoose.connection.dropDatabase()
  const [rAdmin, rTutor, rStudent] = await Role.create([
    { key: 'admin', name: 'Admin', permissions: [] },
    { key: 'tutor', name: 'Tutor', permissions: [] },
    { key: 'student', name: 'Student', permissions: [] },
  ])
  // Roles populated, as portalAuth loads them.
  const mk = async (email, name, role, extra = {}) => {
    const u = await User.create({ email, password: 'secret123', displayName: name, roles: [role._id], ...extra })
    return User.findById(u._id).populate('roles')
  }
  const admin = await mk('a@x.test', 'Admin One', rAdmin)
  const tutor = await mk('t@x.test', 'Tutor One', rTutor)
  const tutor2 = await mk('t2@x.test', 'Tutor Two', rTutor)
  const today = karachiToday()
  const stu = await Student.create({ name: 'Student User', rollNo: 'HIDSMOKE1', status: 'active' })
  const stuUser = await mk('s@x.test', 'Student User', rStudent, { linkedStudentId: stu._id })
  await Student.updateOne({ _id: stu._id }, { userId: stuUser._id })
  let res

  // ── Tasks ──
  console.log('\nTasks')
  const MANAGE = ['task.read', 'task.manage', 'task.leads', 'student.create']
  const lead = await Enrollment.create({ name: 'Lead Person', email: 'lead@x.test', source: 'manual' })
  res = await call(tasks.createTask, reqAs(admin, MANAGE, { body: { title: 'Call the family', type: 'call', assignees: [String(tutor._id), String(stuUser._id)], dueDate: today.iso, allDay: true, leadId: String(lead._id), checklist: [{ text: 'Ask about time' }] } }))
  ok(res._status === 201 && res._json.assignees.length === 2 && res._json.leadId?.name === 'Lead Person', 'manager creates a task for a tutor and a student, linked to a lead')
  const taskId = String(res._json._id)
  ok(await Notification.countDocuments({ type: 'task_assigned' }) === 2, 'both assignees are notified')
  res = await call(tasks.createTask, reqAs(admin, ['task.read', 'task.manage'], { body: { title: 'No lead rights', leadId: String(lead._id) } }))
  ok(res._status === 201 && !res._json.leadId, 'without task.leads the lead link is ignored')
  await Task.deleteOne({ _id: res._json._id })

  res = await call(tasks.listTasks, reqAs(tutor, [], {}))
  ok(res._json.records.length === 1, 'the tutor sees the task assigned to them')
  res = await call(tasks.listTasks, reqAs(tutor2, [], {}))
  ok(res._json.records.length === 0, 'another tutor does not')
  res = await call(tasks.getTask, reqAs(tutor2, [], { params: { id: taskId } }))
  ok(res._status === 404, 'and cannot open it')

  res = await call(tasks.updateTask, reqAs(tutor, [], { params: { id: taskId }, body: { title: 'Hacked', status: 'in_progress' } }))
  ok(res._status === 200 && res._json.title === 'Call the family' && res._json.status === 'in_progress', 'an assignee can move it but not rename it')

  res = await call(tasks.createTask, reqAs(tutor, [], { body: { title: 'For someone else', assignees: [String(stuUser._id)] } }))
  ok(res._status === 403, 'a tutor cannot assign tasks to others')
  res = await call(tasks.createTask, reqAs(tutor, [], { body: { title: 'My own to-do' } }))
  ok(res._status === 201 && res._json.assignees.length === 1 && String(res._json.assignees[0]._id) === String(tutor._id), 'a tutor can add their own to-do')
  res = await call(tasks.createTask, reqAs(stuUser, [], { body: { title: 'Student task' } }))
  ok(res._status === 403, 'a student cannot create tasks')

  res = await call(tasks.reorderTasks, reqAs(stuUser, [], { body: { status: 'done', ids: [taskId] } }))
  ok(res._status === 200 && (await Task.findById(taskId)).status === 'done', 'a student assignee can drag it to Done')
  ok(await Notification.countDocuments({ userId: admin._id, type: 'task_updated' }) === 1, 'the creator hears it is done')

  res = await call(tasks.addTaskComment, reqAs(tutor, [], { params: { id: taskId }, body: { text: 'Called, will join Monday' } }))
  ok(res._status === 201 && res._json.comments.length === 1, 'comment added')

  res = await call(tasks.createGoal, reqAs(admin, MANAGE, { body: { title: 'Enrol 2 students', period: 'weekly', startDate: today.iso, endDate: addDaysIso(today.iso, 6), target: 2 } }))
  ok(res._status === 201, 'weekly goal created')
  await Task.updateOne({ _id: taskId }, { goalId: res._json._id })
  res = await call(tasks.listGoals, reqAs(admin, MANAGE, {}))
  ok(res._json.records[0].doneCount === 1 && res._json.records[0].progress === 50, 'goal progress = done ÷ target')

  res = await call(tasks.listTasks, reqAs(admin, MANAGE, { query: { leadId: String(lead._id) } }))
  ok(res._json.records.length === 1, 'tasks filter by lead')
  res = await call(tasks.listTasks, reqAs(admin, MANAGE, { query: { from: `${today.iso}T00:00:00.000Z`, to: `${addDaysIso(today.iso, 1)}T00:00:00.000Z` } }))
  ok(res._json.records.some(t => String(t._id) === taskId), 'date window finds the task')

  // due-today job: once per due date
  const dueTask = await Task.create({ title: 'Due today job', assignees: [tutor._id], dueDate: new Date(`${today.iso}T00:00:00.000Z`), allDay: true, createdBy: admin._id })
  await tasks.runTaskDueReminders()
  await tasks.runTaskDueReminders()
  ok(await Notification.countDocuments({ userId: tutor._id, type: 'task_due', 'payload.taskId': String(dueTask._id) }) === 1, '"due today" sent once')

  res = await call(tasks.myTaskSummary, reqAs(tutor, [], {}))
  ok(res._json.tasks.some(t => String(t._id) === String(dueTask._id)), 'my summary includes the due task')

  res = await call(tasks.pickAssignees, reqAs(tutor, [], { query: { q: '' } }))
  ok(res._json.length === 1 && String(res._json[0]._id) === String(tutor._id), 'without task.manage the picker only offers yourself')
  res = await call(tasks.pickAssignees, reqAs(admin, MANAGE, { query: { kind: 'student' } }))
  ok(res._json.length === 1 && res._json[0].kind === 'student', 'picker filters students')

  // ── 2026-11-08: repeats, waiting, mentions, bulk + undo, restore, views, windows ──
  console.log('\nTasks: repeats, waiting, mentions, bulk, views')
  res = await call(tasks.createTask, reqAs(admin, MANAGE, { body: { title: 'Weekly test', assignees: [String(tutor._id)], dueDate: today.iso, allDay: true, repeat: { freq: 'weekly', interval: 1 }, checklist: [{ text: 'Mark', done: false }] } }))
  const rep = res._json
  ok(rep.repeat?.freq === 'weekly', 'repeat saved')
  res = await call(tasks.updateTask, reqAs(tutor, [], { params: { id: String(rep._id) }, body: { status: 'done' } }))
  let nextRep = await Task.findOne({ repeatOf: rep._id }).lean()
  ok(nextRep && nextRep.status === 'todo' && new Date(nextRep.dueDate).toISOString().slice(0, 10) === addDaysIso(today.iso, 7) && nextRep.checklist[0].done === false, 'finishing a weekly task makes next week\'s, checklist unticked')
  await call(tasks.updateTask, reqAs(tutor, [], { params: { id: String(rep._id) }, body: { status: 'todo' } }))
  ok(await Task.countDocuments({ repeatOf: rep._id }) === 0, 'un-finishing it takes back the untouched copy')
  await call(tasks.updateTask, reqAs(tutor, [], { params: { id: String(rep._id) }, body: { status: 'done' } }))
  ok(await Task.countDocuments({ repeatOf: rep._id }) === 1, 'finishing it again makes exactly one copy')
  nextRep = await Task.findOne({ repeatOf: rep._id }).lean()

  res = await call(tasks.updateTask, reqAs(tutor, [], { params: { id: String(nextRep._id) }, body: { waiting: { on: true, who: 'Parent', reason: 'Confirm the time', userId: String(admin._id) } } }))
  ok(res._json.waiting?.on && res._json.waiting.who === 'Parent', 'an assignee can mark it waiting')
  ok(await Notification.countDocuments({ userId: admin._id, type: 'task_waiting' }) === 1, 'the person waited on is told')
  await call(tasks.updateTask, reqAs(tutor, [], { params: { id: String(nextRep._id) }, body: { status: 'in_progress' } }))
  ok(await Notification.countDocuments({ userId: admin._id, type: 'task_waiting' }) === 1, 'not told again on an unrelated change')
  res = await call(tasks.myTaskSummary, reqAs(admin, MANAGE, {}))
  ok(res._json.waitingOnMe.some(t => String(t._id) === String(nextRep._id)), 'it shows in "waiting on you"')
  res = await call(tasks.getTask, reqAs(admin, MANAGE, { params: { id: String(nextRep._id) } }))
  ok(res._json.activity.some(a => /waiting on Parent/.test(a.text)) && res._json.activity.some(a => /In progress/.test(a.text)), 'history records waiting and the move')

  await call(tasks.addTaskComment, reqAs(tutor, [], { params: { id: String(nextRep._id) }, body: { text: '@Tutor Two can you cover?', mentions: [String(tutor2._id)] } }))
  ok(await Notification.countDocuments({ userId: tutor2._id, type: 'task_mention' }) === 1, 'a mention notifies')
  res = await call(tasks.getTask, reqAs(tutor2, [], { params: { id: String(nextRep._id) } }))
  ok(res._status === 200, 'and lets the mentioned person open the task')
  await call(tasks.addTaskComment, reqAs(tutor, [], { params: { id: String(nextRep._id) }, body: { text: '@Student User has not paid', mentions: [String(stuUser._id)] } }))
  res = await call(tasks.getTask, reqAs(stuUser, [], { params: { id: String(nextRep._id) } }))
  ok(res._status === 404 && !(await Notification.exists({ userId: stuUser._id, type: 'task_mention' })), 'mentioning a student who is not on the task neither notifies nor shows it to them')

  const unowned = await Task.create({ title: 'Nobody yet', createdBy: admin._id, assignees: [] })
  res = await call(tasks.myTaskSummary, reqAs(admin, MANAGE, {}))
  ok(res._json.unowned.some(t => String(t._id) === String(unowned._id)) && res._json.unownedCount >= 1, 'managers see tasks nobody owns')

  res = await call(tasks.bulkUpdateTasks, reqAs(admin, MANAGE, { body: { ids: [String(unowned._id), String(nextRep._id)], set: { priority: 'urgent', addAssignees: [String(tutor2._id)], shiftDays: 2 } } }))
  ok(res._json.updated === 2 && res._json.undo.length === 2, 'bulk change two tasks')
  const shifted = await Task.findById(nextRep._id).lean()
  ok(shifted.priority === 'urgent' && shifted.assignees.some(a => String(a) === String(tutor2._id)) && new Date(shifted.dueDate).toISOString().slice(0, 10) === addDaysIso(today.iso, 9), 'priority, assignee and date all changed')
  await call(tasks.undoBulkUpdate, reqAs(admin, MANAGE, { body: { undo: JSON.parse(JSON.stringify(res._json.undo)) } }))
  const undone = await Task.findById(nextRep._id).lean()
  ok(undone.priority === 'normal' && !undone.assignees.some(a => String(a) === String(tutor2._id)) && new Date(undone.dueDate).toISOString().slice(0, 10) === addDaysIso(today.iso, 7), 'undo puts them back')
  res = await call(tasks.bulkUpdateTasks, reqAs(tutor, [], { body: { ids: [String(unowned._id)], set: { priority: 'low' } } }))
  ok(res._status === 403, 'bulk changes need task.manage')

  res = await call(tasks.bulkDeleteTasks, reqAs(admin, MANAGE, { body: { ids: [String(unowned._id)] } }))
  ok(res._json.deleted.length === 1 && !(await Task.exists({ _id: unowned._id })), 'bulk delete')
  await call(tasks.restoreTasks, reqAs(admin, MANAGE, { body: { tasks: JSON.parse(JSON.stringify(res._json.deleted)) } }))
  ok(await Task.exists({ _id: unowned._id }), 'restore brings it back with the same id')

  res = await call(tasks.listTasks, reqAs(admin, MANAGE, { query: { doneSince: new Date(Date.now() + 60000).toISOString() } }))
  ok(res._json.records.every(t => t.status !== 'done') && res._json.records.length > 0, 'doneSince leaves out tasks finished earlier')
  res = await call(tasks.listTasks, reqAs(admin, MANAGE, { query: { noDue: '1' } }))
  ok(res._json.records.every(t => !t.dueDate), 'noDue lists undated tasks only')
  res = await call(tasks.listTasks, reqAs(admin, MANAGE, { query: { dueFrom: `${today.iso}T00:00:00.000Z`, dueTo: `${addDaysIso(today.iso, 7)}T23:59:59.999Z`, limit: '1' } }))
  ok(res._json.records.length === 1 && res._json.total >= 2 && res._json.records.every(t => !t.activity), 'due range pages, and lists skip the history')

  res = await call(tasks.createTaskView, reqAs(tutor, [], { body: { name: 'My calls', filters: { type: 'call' }, shared: true } }))
  ok(res._status === 201 && res._json.shared === false, 'saved view; only managers can share')
  await call(tasks.createTaskView, reqAs(admin, MANAGE, { body: { name: 'Overdue, everyone', filters: { due: 'overdue' }, shared: true } }))
  res = await call(tasks.listTaskViews, reqAs(tutor2, [], {}))
  ok(res._json.records.length === 1 && res._json.records[0].name === 'Overdue, everyone', 'others see shared views, not private ones')

  // Recurring column: a daily task, ticked "Checked today", reminded once a shift
  res = await call(tasks.createTask, reqAs(admin, MANAGE, { body: { title: 'Check WhatsApp leads', status: 'recurring', assignees: [String(tutor._id)] } }))
  const dailyId = String(res._json._id)
  ok(res._status === 201 && res._json.status === 'recurring', 'a task can sit in the Recurring column')
  res = await call(tasks.myTaskSummary, reqAs(tutor, [], {}))
  ok(res._json.daily.some(t => String(t._id) === dailyId && !t.checkedToday) && !res._json.undated.some(t => String(t._id) === dailyId), 'My work lists it under every day, not undated')
  const pkHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', hourCycle: 'h23' }).format(new Date()))
  await tasks.runTaskDueReminders()
  await tasks.runTaskDueReminders()
  const dailyNotes = await Notification.countDocuments({ userId: tutor._id, title: 'Today: Check WhatsApp leads' })
  ok(pkHour >= 19 || pkHour < 7 ? dailyNotes === 1 : dailyNotes === 0, `daily reminder sent at most once a shift (${dailyNotes} at ${pkHour}:00 PKT)`)
  res = await call(tasks.updateTask, reqAs(tutor, [], { params: { id: dailyId }, body: { checkedToday: true } }))
  ok(res._status === 200 && res._json.checkedToday === true && res._json.status === 'recurring', 'an assignee ticks "Checked today"; it stays recurring')
  res = await call(tasks.listTasks, reqAs(tutor, [], {}))
  ok(res._json.records.find(t => String(t._id) === dailyId)?.checkedToday === true, 'the board shows it checked')

  // Leads list: open-task count + soonest due date per lead
  await Task.updateOne({ _id: taskId }, { status: 'todo' })
  res = await call(leads.listLeads, reqAs(admin, ['student.create'], { query: {} }))
  const leadRow = (res._json.records || []).find(l => String(l._id) === String(lead._id))
  ok(leadRow?.openTasks === 1 && new Date(leadRow.nextTaskDue).toISOString().slice(0, 10) === today.iso, 'leads list shows the open task and when it is due')

  res = await call(tasks.deleteTask, reqAs(tutor, [], { params: { id: taskId } }))
  ok(res._status === 403, 'an assignee cannot delete')
  res = await call(tasks.deleteTask, reqAs(admin, MANAGE, { params: { id: taskId } }))
  ok(res._status === 200, 'a manager can delete')
} catch (err) {
  fail++
  console.error('Smoke crashed:', err)
} finally {
  if (mongoose.connection.name === SMOKE_DB) await mongoose.connection.dropDatabase().catch(() => {})
  await mongoose.disconnect()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

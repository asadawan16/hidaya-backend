// Smoke test for the 2026-11-07 features: fee due days (joining date), the
// dues-by-day list, fee reminders, editable PKR rates + revenue by currency,
// and the Tasks board (permissions, notifications, reorder, goals, due job).
//
// Runs against a THROWAWAY database (dbName mfc_smoke_tasks_fees) on the
// cluster MONGODB_URI names, and drops it afterwards. No running server needed.
//   node scripts/smoke-tasks-fees.mjs
import 'dotenv/config'
import mongoose from 'mongoose'

const SMOKE_DB = 'mfc_smoke_tasks_fees'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB, serverSelectionTimeoutMS: 8000 })
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}

const { default: Role } = await import('../models/Role.js')
const { default: User } = await import('../models/User.js')
const { default: Student } = await import('../models/Student.js')
const { default: StudentFeeRecord } = await import('../models/StudentFeeRecord.js')
const { default: FeePayment } = await import('../models/FeePayment.js')
const { default: Notification } = await import('../models/Notification.js')
const { default: Task } = await import('../models/Task.js')
const { default: Enrollment } = await import('../models/Enrollment.js')
await import('../models/Family.js'); await import('../models/Payment.js')
const fee = await import('../controllers/portalFeeController.js')
const dash = await import('../controllers/portalDashboardController.js')
const tasks = await import('../controllers/portalTaskController.js')
const { collectDues, duesSummary } = await import('../services/feeDues.js')
const { sendDayBeforeReminder, sendDailyDigest } = await import('../services/feeReminders.js')
const { karachiToday, addDaysIso, dueDayOf, isMonthDue } = await import('../utils/feeDue.js')

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
  const tomorrow = addDaysIso(today.iso, 1)
  const tDay = Number(tomorrow.slice(8, 10))

  // ── Fees: due day + dues list ──
  console.log('\nFees')
  const sTomorrow = await Student.create({ name: 'Due Tomorrow', rollNo: 'MFC90', status: 'active', joiningDate: new Date('2026-10-01'), billing: { amount: 45, currency: 'USD', dueDay: tDay } })
  const stuUser = await mk('s@x.test', 'Student User', rStudent, { linkedStudentId: sTomorrow._id })
  await Student.updateOne({ _id: sTomorrow._id }, { userId: stuUser._id })
  const joinDay = new Date(`${today.iso}T00:00:00.000Z`); joinDay.setUTCMonth(joinDay.getUTCMonth() - 2)
  const sJoin = await Student.create({ name: 'By Joining Day', rollNo: 'MFC91', status: 'active', joiningDate: joinDay, billing: { amount: 30, currency: 'GBP' } })
  ok(dueDayOf(sJoin) === joinDay.getUTCDate(), 'due day defaults to the joining day')
  ok(dueDayOf(sTomorrow) === tDay, 'billing.dueDay overrides the joining day')
  ok(isMonthDue(10, 2026, 11, { year: 2026, month: 11, day: 10 }), 'a month is due on its due day')
  ok(!isMonthDue(10, 2026, 11, { year: 2026, month: 11, day: 9 }), 'a month is not due before its due day')
  ok(isMonthDue(31, 2026, 2, { year: 2026, month: 2, day: 28 }), 'a 31st due day lands on the last day of February')

  const sum = await duesSummary({ days: 7 })
  ok(sum.dueTomorrow.some(r => String(r.studentId) === String(sTomorrow._id) && r.balance === 45 && r.currency === 'USD'), 'student due tomorrow is listed with USD 45')
  ok(sum.overdue.some(r => String(r.studentId) === String(sJoin._id) && r.currency === 'GBP'), 'an unpaid earlier month of the joining-day student is overdue')
  ok(sum.totals.pending.list.some(t => t.currency === 'GBP') && sum.totals.pending.pkrTotal > 0, 'pending totals per currency and in PKR')

  // pay last month for sJoin → that month leaves the overdue list
  const lastMonth = sum.overdue.find(r => String(r.studentId) === String(sJoin._id))
  let res = await call(fee.createFeePayment, reqAs(admin, ['fee.manage'], { body: { amount: 30, currency: 'GBP', method: 'wise', allocations: [{ studentId: String(sJoin._id), year: lastMonth.year, month: lastMonth.month, amount: 30 }] } }))
  ok(res._status === 201, 'record a GBP payment')
  const after = await collectDues({ fromIso: today.iso, toIso: today.iso })
  ok(!after.overdue.some(r => String(r.studentId) === String(sJoin._id) && r.year === lastMonth.year && r.month === lastMonth.month), 'a paid month is no longer overdue')

  res = await call(fee.getFeeDues, reqAs(admin, ['fee.read'], { query: { from: today.iso, to: addDaysIso(today.iso, 30) } }))
  ok(res._status === 200 && Array.isArray(res._json.items) && res._json.items.every(i => i.dueDate >= today.iso), 'GET dues lists the window')
  ok(res._json.items.some(i => String(i.studentId) === String(sTomorrow._id) && i.state === 'soon'), 'tomorrow reads as "soon"')

  res = await call(fee.getFeeGrid, reqAs(admin, ['fee.read'], { query: { year: String(today.year), fromMonth: String(today.month), toMonth: String(today.month), limit: 'all' } }))
  const row = res._json.records.find(r => r.rollNo === 'MFC90')
  ok(row && row.dueDay === tDay && row.dueStates, 'grid rows carry dueDay and dueStates')
  ok(Array.isArray(res._json.summary.byCurrency), 'grid summary has per-currency totals')

  // reminders
  await sendDayBeforeReminder({ recipientRoles: ['admin'], notifyStudents: true })
  ok(await Notification.countDocuments({ userId: admin._id, type: 'fee_due_tomorrow' }) === 1, 'day-before reminder reaches the admin role')
  ok(await Notification.countDocuments({ userId: stuUser._id, type: 'fee_due_student' }) === 1, 'day-before reminder reaches the student when enabled')
  await sendDailyDigest({ recipientRoles: ['admin'] })
  ok(await Notification.countDocuments({ userId: admin._id, type: 'fee_digest' }) === 1, 'daily digest sent')

  // ── Revenue: rates + currency breakdown ──
  console.log('\nRevenue')
  res = await call(dash.updateCurrencyRates, reqAs(admin, ['revenue.manage'], { body: { rates: { USD: 300, GBP: 400 } } }))
  ok(res._status === 200 && res._json.rates.USD === 300 && res._json.rates.GBP === 400, 'rates saved')
  res = await call(dash.updateCurrencyRates, reqAs(admin, ['revenue.manage'], { body: { rates: { USD: -1 } } }))
  ok(res._status === 400, 'a negative rate is refused')
  res = await call(dash.getRevenueStats, reqAs(admin, ['revenue.read'], { query: { year: String(today.year), fromMonth: '1', toMonth: '12' } }))
  const gbp = res._json?.receivedByCurrency?.find(c => c.currency === 'GBP')
  ok(res._status === 200 && gbp && gbp.manual === 30 && gbp.pkrEquiv === 12000, 'manual GBP payment shows in the currency breakdown at the new rate')
  ok(res._json.conversionRates.GBP === 400 && res._json.outstanding, 'revenue returns the rates and outstanding dues')

  // ── Tasks ──
  console.log('\nTasks')
  const MANAGE = ['task.read', 'task.manage', 'student.create']
  const lead = await Enrollment.create({ name: 'Lead Person', email: 'lead@x.test', source: 'manual' })
  res = await call(tasks.createTask, reqAs(admin, MANAGE, { body: { title: 'Call the family', type: 'call', assignees: [String(tutor._id), String(stuUser._id)], dueDate: today.iso, allDay: true, leadId: String(lead._id), checklist: [{ text: 'Ask about time' }] } }))
  ok(res._status === 201 && res._json.assignees.length === 2 && res._json.leadId?.name === 'Lead Person', 'manager creates a task for a tutor and a student, linked to a lead')
  const taskId = String(res._json._id)
  ok(await Notification.countDocuments({ type: 'task_assigned' }) === 2, 'both assignees are notified')

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

// Smoke test for English Coach levels and assigned tests (Nov 2026):
// the Levels tab (save, validation, ids kept), level locking and progress,
// level tests fixing the difficulty / length / start, the level-complete
// notifications, assigned tests (who may take them, pass marks, attempts,
// the assigner's notification), tests on tasks (one assignment per assignee,
// kept in step with the task, assignees can't tick it done, the task finishes
// itself when the last one passes, repeats, delete) and the team view.
//
// Runs against a THROWAWAY database (dbName hidaya_coach_levels_smoke) on the
// cluster MONGODB_URI names, and drops it afterwards. No server, no AI keys.
//   node scripts/smoke-coach-levels.mjs
import 'dotenv/config'
import mongoose from 'mongoose'

const SMOKE_DB = 'hidaya_coach_levels_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB, serverSelectionTimeoutMS: 8000 })
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
// Starting a call checks a key is set; no AI is called (openings are scripted)
process.env.GROQ_API_KEY = 'gsk_test'

const { default: Role } = await import('../models/Role.js')
const { default: User } = await import('../models/User.js')
const { default: Notification } = await import('../models/Notification.js')
const { default: Task } = await import('../models/Task.js')
const { default: CoachSession } = await import('../models/CoachSession.js')
const { default: CoachSettings } = await import('../models/CoachSettings.js')
const { default: CoachAssignment } = await import('../models/CoachAssignment.js')
const coach = await import('../controllers/portalCoachController.js')
const levelsCtl = await import('../controllers/portalCoachLevelController.js')
const tasks = await import('../controllers/portalTaskController.js')
const { onSessionScored, levelProgress } = await import('../services/coachProgress.js')
const { ensureBookScripts } = await import('../services/coachScripts.js')
const { SCENARIO_KEYS } = await import('../config/coachScenarios.js')

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }
const mockRes = () => { const r = { _status: 200, _json: null }; r.status = (c) => { r._status = c; return r }; r.json = (d) => { r._json = d; return r }; return r }
const call = async (fn, req) => { const r = mockRes(); await fn(req, r); return r }
const ADMIN_PERMS = ['coach.practice', 'coach.review', 'coach.manage', 'coach.manager', 'task.manage', 'task.read']
const reqAs = (user, perms, { body = {}, query = {}, params = {} } = {}) => ({
  userId: user._id, user, userPermissions: new Set(perms), body, query, params, headers: {}, ip: '127.0.0.1',
})
const notes = (user, type) => Notification.find({ userId: user._id, type }).lean()

/** End a call with a mark, the way scoreSession does, and run the progress hook. */
async function markCall(sessionId, overall) {
  const s = await CoachSession.findByIdAndUpdate(sessionId, {
    $set: { status: 'scored', endedAt: new Date(), scoredAt: new Date(), result: { overall, band: overall >= 70 ? 'good' : 'developing', scores: {} } },
  }, { new: true })
  await onSessionScored(s)
  return s
}
const CONV = SCENARIO_KEYS[0]

try {
  await mongoose.connection.dropDatabase()
  await Promise.all([CoachSession.syncIndexes(), CoachAssignment.syncIndexes(), User.syncIndexes()])
  await ensureBookScripts()
  // Many calls per person below; the daily cap is tested in smoke-english-coach
  await CoachSettings.getSettings()
  await CoachSettings.updateOne({ key: 'default' }, { $set: { dailyLimitPerUser: 0 } })

  const [rAdmin, rTutor, rStaff] = await Role.create([
    { key: 'admin', name: 'Admin', permissions: ADMIN_PERMS },
    { key: 'tutor', name: 'Tutor', permissions: ['coach.practice'] },
    { key: 'coordinator', name: 'Coordinator', permissions: ['task.read'] },
  ])
  const mk = async (email, name, role) => {
    const u = await User.create({ email, password: 'secret123', displayName: name, roles: [role._id] })
    return User.findById(u._id).populate('roles')
  }
  const admin = await mk('admin@x.test', 'Admin One', rAdmin)
  const tutor = await mk('t1@x.test', 'Tutor One', rTutor)
  const tutor2 = await mk('t2@x.test', 'Tutor Two', rTutor)
  const staff = await mk('s@x.test', 'Staff NoCoach', rStaff)
  const asAdmin = (o) => reqAs(admin, ADMIN_PERMS, o)
  const asTutor = (o, u = tutor) => reqAs(u, ['coach.practice'], o)
  let r

  // ── The ladder ──────────────────────────────────────────────────────────
  console.log('\nLevels: save and validate')
  r = await call(levelsCtl.saveLevels, asAdmin({ body: { levels: [{ title: 'Empty', items: [] }] } }))
  ok(r._status === 400 && /no tests/.test(r._json.error), 'a level with no tests is refused')
  r = await call(levelsCtl.saveLevels, asAdmin({ body: { levels: [{ items: [{ scenarioKey: 'book_unit_01', difficulty: 'impossible' }] }] } }))
  ok(r._status === 400 && /difficulty/.test(r._json.error), 'an unknown difficulty is refused')
  r = await call(levelsCtl.saveLevels, asAdmin({ body: { levels: [{ items: [{ scenarioKey: 'nope', difficulty: 'easy' }] }] } }))
  ok(r._status === 400, 'an unknown script is refused')
  r = await call(levelsCtl.saveLevels, asAdmin({ body: { levels: [{ items: [{ scenarioKey: 'book_unit_01', difficulty: 'easy', passScore: 140 }] }] } }))
  ok(r._status === 400 && /pass mark/.test(r._json.error), 'a pass mark over 100 is refused')
  r = await call(levelsCtl.saveLevels, asAdmin({ body: { levels: [{ items: [{ scenarioKey: 'book_unit_01', difficulty: 'easy' }, { scenarioKey: 'book_unit_01', difficulty: 'easy' }] }] } }))
  ok(r._status === 400 && /twice/.test(r._json.error), 'the same test twice in a level is refused')
  r = await call(levelsCtl.saveLevels, asAdmin({ body: { levels: [{ items: [{ scenarioKey: 'book_unit_01', difficulty: 'easy', durationMin: 7 }] }] } }))
  ok(r._status === 400 && /call length/.test(r._json.error), 'a call length that is not offered is refused')

  r = await call(levelsCtl.saveLevels, asAdmin({
    body: {
      levels: [
        { title: 'Greetings', note: 'Start here', items: [
          { scenarioKey: 'book_unit_01', difficulty: 'easy', durationMin: 15, passScore: 60 },
          { scenarioKey: CONV, difficulty: 'normal', passScore: 70 },
        ] },
        { title: 'In class', items: [{ scenarioKey: 'book_unit_02', difficulty: 'normal', durationMin: 10, passScore: 75 }] },
      ],
    },
  }))
  ok(r._status === 200 && r._json.levels.length === 2, 'two levels saved')
  const L = r._json.levels
  ok(L[0].number === 1 && L[0].title === 'Greetings' && L[0].items.length === 2, 'level 1 keeps its title and two tests')
  ok(L[0].items[1].passScore === 70 && L[0].items[1].durationMin === null, 'pass mark kept; no length = the tester chooses')
  ok(L[0].items[0].kind === 'script' && L[0].items[1].kind === 'conversation', 'scripts and conversations are both allowed')
  const [item1, item2] = L[0].items
  const item3 = L[1].items[0]

  r = await call(levelsCtl.getLevels, asAdmin())
  ok(r._json.scenarios.some(s => s.key === 'book_unit_01') && r._json.durations.includes(15), 'the editor gets every script and the call lengths')

  console.log('\nLevels: the tester')
  r = await call(coach.getConfig, asTutor())
  ok(r._json.levels?.current === 1 && r._json.levels.levels[1].state === 'locked', 'a new tester is on Level 1; Level 2 is locked')
  ok(r._json.levels.levels[0].items[0].scenario?.key === 'book_unit_01', 'each level test carries its scenario for the call screen')

  r = await call(coach.startSession, asTutor({ body: { levelItemId: String(item3.id), consent: true, durationMin: 5 } }))
  ok(r._status === 403 && r._json.code === 'level_locked', 'a Level 2 test can\'t be started on Level 1')

  r = await call(coach.startSession, asTutor({ body: { levelItemId: String(item1.id), consent: true, difficulty: 'hard', durationMin: 3, startPlay: 2, scenarioKey: CONV } }))
  ok(r._status === 201, 'a Level 1 test starts')
  let s = await CoachSession.findById(r._json.session.id).lean()
  ok(s.scenarioKey === 'book_unit_01' && s.difficulty === 'easy', 'the level fixes the script and difficulty, whatever the browser sends')
  ok(s.durationSec === 15 * 60, 'the level\'s call length is used, even one not offered in Settings')
  ok(s.script?.startPlay === 0, 'a level script runs from its first role play')
  ok(String(s.levelItemId) === String(item1.id) && s.levelNumber === 1 && s.passScore === 60, 'the call remembers its level test and pass mark')
  ok(r._json.session.goal?.kind === 'level' && r._json.session.goal.passScore === 60, 'the session view says it is a level test')

  await markCall(s._id, 55)
  r = await call(coach.getConfig, asTutor())
  ok(r._json.levels.levels[0].items[0].best === 55 && !r._json.levels.levels[0].items[0].passed, 'a 55 on a 60 pass mark is recorded, not passed')
  r = await call(coach.getSession, asTutor({ params: { id: String(s._id) } }))
  ok(r._json.session.goal.passed === false, 'the scorecard says the pass mark was missed')

  r = await call(coach.startSession, asTutor({ body: { levelItemId: String(item1.id), consent: true } }))
  await markCall(r._json.session.id, 66)
  r = await call(coach.startSession, asTutor({ body: { levelItemId: String(item2.id), consent: true, durationMin: 5 } }))
  ok(r._status === 201 && r._json.session.difficulty === 'normal', 'a conversation level test starts at its fixed difficulty')
  const passing = r._json.session.id
  ok((await notes(tutor, 'coach_level')).length === 0, 'no level notification before the level is complete')
  await markCall(passing, 81)
  r = await call(coach.getConfig, asTutor())
  ok(r._json.levels.current === 2 && r._json.levels.levels[0].state === 'done', 'passing both tests completes Level 1 and opens Level 2')
  let n = await notes(tutor, 'coach_level')
  ok(n.length === 1 && /Level 1 · Greetings complete/.test(n[0].title), 'the tester is told the level is complete')
  n = await notes(admin, 'coach_level')
  ok(n.length === 1 && /Tutor One completed English Level 1/.test(n[0].title), 'the coach managers are told too')

  // A later pass of the same test doesn't notify again
  r = await call(coach.startSession, asTutor({ body: { levelItemId: String(item2.id), consent: true, durationMin: 5 } }))
  await markCall(r._json.session.id, 90)
  ok((await notes(tutor, 'coach_level')).length === 1, 'passing a test again doesn\'t repeat the notification')

  // Free practice of the same script doesn't count for the level
  r = await call(coach.startSession, asTutor({ body: { scenarioKey: 'book_unit_02', difficulty: 'normal', durationMin: 10, consent: true } }))
  ok(r._status === 201 && !r._json.session.goal, 'free practice is not a level test')
  await markCall(r._json.session.id, 99)
  let prog = (await levelProgress([tutor._id], (await CoachSettings.getSettings()).levels)).get(String(tutor._id))
  ok(prog.levels[1].items[0].best === null, 'a free-practice call never counts toward a level')

  console.log('\nLevels: editing the ladder')
  let cfg = await CoachSettings.getSettings()
  const ladder = levelsCtl // keep the names short below
  const sendBack = (levels) => levels.map(l => ({ id: String(l.id), title: l.title, note: l.note, items: l.items.map(i => ({ id: String(i.id), scenarioKey: i.scenarioKey, difficulty: i.difficulty, durationMin: i.durationMin, passScore: i.passScore })) }))
  r = await call(ladder.getLevels, asAdmin())
  r = await call(ladder.saveLevels, asAdmin({ body: { levels: sendBack(r._json.levels) } }))
  ok(String(r._json.levels[0].items[0].id) === String(item1.id), 'saving the ladder again keeps each test\'s id')
  r = await call(coach.getConfig, asTutor())
  ok(r._json.levels.current === 2, 'so progress survives a save')

  r = await call(ladder.getLevels, asAdmin())
  const tougher = sendBack(r._json.levels)
  tougher[0].items[0].passScore = 70
  await call(ladder.saveLevels, asAdmin({ body: { levels: tougher } }))
  r = await call(coach.getConfig, asTutor())
  ok(r._json.levels.current === 1 && !r._json.levels.levels[0].items[0].passed, 'raising a pass mark re-reads progress (66 < 70: back on Level 1)')
  tougher[0].items[0].passScore = 60
  tougher[0].items[1].difficulty = 'hard'
  await call(ladder.saveLevels, asAdmin({ body: { levels: tougher } }))
  r = await call(coach.getConfig, asTutor())
  ok(r._json.levels.levels[0].items[1].best === null && r._json.levels.current === 1, 'changing a test\'s difficulty drops the calls taken at the old one')
  tougher[0].items[1].difficulty = 'normal'
  await call(ladder.saveLevels, asAdmin({ body: { levels: tougher } }))

  console.log('\nLevels: the team view')
  r = await call(ladder.levelTeam, asAdmin())
  const t1 = r._json.people.find(p => p.user.name === 'Tutor One')
  const t2 = r._json.people.find(p => p.user.name === 'Tutor Two')
  ok(r._json.total === 2 && t1?.current === 2 && t2?.current === 1, 'each person\'s level is listed')
  ok(!r._json.people.some(p => p.user.name === 'Staff NoCoach'), 'people who can\'t practise are left out')
  ok(r._json.spread[0].people >= 1 && r._json.spread[1].people === 1, 'the spread counts people per level')
  r = await call(ladder.levelTeam, asAdmin({ query: { q: 'two' } }))
  ok(r._json.people.length === 1 && r._json.people[0].user.name === 'Tutor Two', 'the team view searches by name')

  // ── Assigned tests ──────────────────────────────────────────────────────
  console.log('\nAssigned tests')
  r = await call(levelsCtl.listPractisers, asAdmin({ query: { q: 'tutor' } }))
  ok(r._json.items.length === 2, 'the people picker lists those who can practise')
  r = await call(levelsCtl.createAssignments, asAdmin({ body: { userIds: [String(tutor._id), String(staff._id)], scenarioKey: 'book_unit_03', difficulty: 'normal' } }))
  ok(r._status === 400 && r._json.code === 'cannot_practise' && /Staff NoCoach/.test(r._json.error), 'someone without the Practice permission can\'t be given a test')
  r = await call(levelsCtl.createAssignments, asAdmin({ body: { userIds: [String(tutor._id)], scenarioKey: 'book_unit_03', difficulty: 'normal', passScore: 70, dueAt: '2030-01-15', note: 'Before Friday' } }))
  ok(r._status === 201 && r._json.items.length === 1, 'a test is assigned')
  const asg = r._json.items[0]
  ok(asg.passScore === 70 && asg.status === 'pending' && asg.note === 'Before Friday' && asg.dueAt, 'with its pass mark, note and due date')
  n = await notes(tutor, 'coach_assigned')
  ok(n.length === 1 && /book|unit|English test/i.test(n[0].title), 'the tester is notified')

  r = await call(coach.getConfig, asTutor())
  ok(r._json.assignments.length === 1 && r._json.assignments[0].scenario?.key === 'book_unit_03', 'it is on the tester\'s Practice tab')

  r = await call(coach.startSession, asTutor({ body: { assignmentId: asg.id, consent: true, durationMin: 5 } }, tutor2))
  ok(r._status === 404, 'someone else can\'t start it')
  r = await call(coach.startSession, asTutor({ body: { assignmentId: asg.id, consent: true, durationMin: 5, difficulty: 'very_easy' } }))
  ok(r._status === 201 && r._json.session.difficulty === 'normal' && r._json.session.goal?.kind === 'assignment', 'it starts at the assigned difficulty')
  await markCall(r._json.session.id, 60)
  let a = await CoachAssignment.findById(asg.id).lean()
  ok(a.status === 'pending' && a.attempts === 1 && a.bestScore === 60, 'a call below the pass mark counts as an attempt, not a pass')
  ok((await notes(admin, 'coach_completed')).length === 0, 'the assigner is not told about a fail')

  r = await call(coach.startSession, asTutor({ body: { assignmentId: asg.id, consent: true, durationMin: 5 } }))
  const winning = r._json.session.id
  await markCall(winning, 84)
  a = await CoachAssignment.findById(asg.id).lean()
  ok(a.status === 'completed' && a.score === 84 && a.attempts === 2 && String(a.sessionId) === String(winning), 'passing completes it, with the score and the call')
  n = await notes(admin, 'coach_completed')
  ok(n.length === 1 && /Tutor One passed an English test/.test(n[0].title) && n[0].payload.sessionId === String(winning), 'the assigner is told, with a link to the scorecard')
  r = await call(coach.startSession, asTutor({ body: { assignmentId: asg.id, consent: true, durationMin: 5 } }))
  ok(r._status === 409 && r._json.code === 'assignment_done', 'a passed test can\'t be started again')

  r = await call(levelsCtl.listAssignments, asAdmin({ query: { status: 'completed' } }))
  ok(r._json.items.length === 1 && r._json.counts.completed === 1, 'the list filters by status and counts them')

  r = await call(levelsCtl.createAssignments, asAdmin({ body: { userIds: [String(tutor2._id)], scenarioKey: CONV, difficulty: 'easy', dueAt: '2020-01-01' } }))
  r = await call(levelsCtl.listAssignments, asAdmin({ query: { status: 'overdue' } }))
  ok(r._json.items.length === 1 && r._json.items[0].overdue && r._json.counts.overdue === 1, 'a test past its due date shows as overdue')
  r = await call(levelsCtl.deleteAssignment, asAdmin({ params: { assignmentId: String(r._json.items[0].id) } }))
  ok(r._status === 200, 'an assigned test can be removed')

  // ── Tests on tasks ──────────────────────────────────────────────────────
  console.log('\nTests on tasks (from the Assigned tests tab)')
  const coachNotesBefore = (await notes(tutor2, 'coach_assigned')).length
  r = await call(levelsCtl.createAssignments, asAdmin({ body: { userIds: [String(tutor2._id)], scenarioKey: 'book_unit_04', difficulty: 'easy', passScore: 50, addTask: true, dueAt: '2030-02-01' } }))
  ok(r._status === 201 && r._json.items[0].taskId, 'with "add to Tasks", the test is linked to a new task')
  const tAsg = r._json.items[0]
  let task = await Task.findById(tAsg.taskId).lean()
  ok(task.type === 'test' && task.coachTest?.scenarioKey === 'book_unit_04' && String(task.assignees[0]) === String(tutor2._id), 'the task is a Test, for that person, carrying the test')
  ok((await notes(tutor2, 'task_assigned')).length === 1 && (await notes(tutor2, 'coach_assigned')).length === coachNotesBefore, 'one notification (the task\'s), not two')

  r = await call(tasks.updateTask, reqAs(tutor2, ['coach.practice'], { params: { id: String(task._id) }, body: { status: 'done' } }))
  ok(r._status === 409 && r._json.code === 'test_pending', 'the assignee can\'t tick it done before passing')
  await call(tasks.reorderTasks, reqAs(tutor2, ['coach.practice'], { body: { status: 'done', ids: [String(task._id)] } }))
  ok((await Task.findById(task._id).lean()).status === 'todo', '…or drag it into Done')
  r = await call(levelsCtl.deleteAssignment, asAdmin({ params: { assignmentId: String(tAsg.id) } }))
  ok(r._status === 409 && r._json.code === 'on_task', 'a task\'s test is removed from the task, not from here')

  r = await call(coach.startSession, asTutor({ body: { assignmentId: String(tAsg.id), consent: true, durationMin: 5 } }, tutor2))
  await markCall(r._json.session.id, 72)
  task = await Task.findById(task._id).lean()
  ok(task.status === 'done' && task.completedAt, 'passing the test moves the task to Done')
  ok(task.activity.some(x => /passed the English test \(72\/100\)/.test(x.text)), 'and says so in its history')

  console.log('\nTests on tasks (from the Tasks board)')
  r = await call(tasks.createTask, reqAs(staff, ['task.manage'], { body: { title: 'Practise', assignees: [String(tutor._id)], coachTest: { scenarioKey: CONV, difficulty: 'easy' } } }))
  ok(r._status === 400 && /reviewers/.test(r._json.error), 'only coach reviewers can put a test on a task')
  r = await call(tasks.createTask, asAdmin({ body: { title: 'Practise', assignees: [String(staff._id)], coachTest: { scenarioKey: CONV, difficulty: 'easy' } } }))
  ok(r._status === 400 && /Staff NoCoach/.test(r._json.error), 'a test task can\'t go to someone who can\'t practise')
  r = await call(tasks.createTask, asAdmin({ body: { title: 'Phone manner', assignees: [String(tutor._id), String(tutor2._id)], dueDate: '2030-03-01', coachTest: { scenarioKey: CONV, difficulty: 'easy', passScore: 65 } } }))
  ok(r._status === 201, 'a task with a test for two people is created')
  const both = r._json
  let list = await CoachAssignment.find({ taskId: both._id }).lean()
  ok(list.length === 2 && list.every(x => x.passScore === 65 && x.difficulty === 'easy' && x.dueAt), 'each assignee gets the test, with the task\'s due date')

  r = await call(tasks.getTask, reqAs(tutor, ['coach.practice'], { params: { id: String(both._id) } }))
  ok(r._json.coachTestProgress?.length === 2 && r._json.coachTestProgress.every(x => x.status === 'pending'), 'the task shows each person\'s progress on the test')

  r = await call(tasks.updateTask, asAdmin({ params: { id: String(both._id) }, body: { coachTest: { scenarioKey: CONV, difficulty: 'normal', passScore: 65 } } }))
  ok(r._status === 200, 'the test on a task can be changed')
  list = await CoachAssignment.find({ taskId: both._id }).lean()
  ok(list.every(x => x.difficulty === 'normal'), 'the people still to pass get the new test')

  const t2asg = list.find(x => String(x.userId) === String(tutor2._id))
  r = await call(coach.startSession, asTutor({ body: { assignmentId: String(t2asg._id), consent: true, durationMin: 5 } }, tutor2))
  await markCall(r._json.session.id, 70)
  task = await Task.findById(both._id).lean()
  ok(task.status !== 'done', 'one of two passing leaves the task open')

  r = await call(tasks.updateTask, asAdmin({ params: { id: String(both._id) }, body: { assignees: [String(tutor2._id)] } }))
  list = await CoachAssignment.find({ taskId: both._id }).lean()
  ok(list.length === 1 && String(list[0].userId) === String(tutor2._id), 'taking someone off the task removes their unfinished test')

  r = await call(tasks.updateTask, asAdmin({ params: { id: String(both._id) }, body: { assignees: [String(tutor2._id), String(tutor._id)] } }))
  const back = await CoachAssignment.findOne({ taskId: both._id, userId: tutor._id }).lean()
  r = await call(coach.startSession, asTutor({ body: { assignmentId: String(back._id), consent: true, durationMin: 5 } }))
  await markCall(r._json.session.id, 90)
  task = await Task.findById(both._id).lean()
  ok(task.status === 'done', 'the last person passing finishes the task')

  r = await call(tasks.createTask, asAdmin({ body: { title: 'Weekly test', assignees: [String(tutor._id)], dueDate: '2030-04-01', repeat: { freq: 'weekly', interval: 1, weekdays: [1] }, coachTest: { scenarioKey: 'book_unit_05', difficulty: 'easy' } } }))
  const weekly = r._json
  const wAsg = await CoachAssignment.findOne({ taskId: weekly._id }).lean()
  r = await call(coach.startSession, asTutor({ body: { assignmentId: String(wAsg._id), consent: true, durationMin: 5 } }))
  await markCall(r._json.session.id, 40)
  task = await Task.findById(weekly._id).lean()
  ok(task.status === 'done' && task.repeatedInto, 'a 0 pass mark means any marked call finishes it (repeating task done)')
  const nextT = await Task.findById(task.repeatedInto).lean()
  ok(nextT?.coachTest?.scenarioKey === 'book_unit_05', 'the next task in the series carries the test')
  ok(await CoachAssignment.exists({ taskId: nextT._id, userId: tutor._id, status: 'pending' }), 'and gives it to the assignee again')

  r = await call(tasks.updateTask, asAdmin({ params: { id: String(nextT._id) }, body: { coachTest: null } }))
  ok(!(await CoachAssignment.exists({ taskId: nextT._id })), 'taking the test off a task removes the unfinished test')

  r = await call(tasks.createTask, asAdmin({ body: { title: 'Gone soon', assignees: [String(tutor._id)], coachTest: { scenarioKey: CONV, difficulty: 'easy' } } }))
  const gone = r._json
  r = await call(tasks.deleteTask, asAdmin({ params: { id: String(gone._id) } }))
  ok(!(await CoachAssignment.exists({ taskId: gone._id })), 'deleting a task removes its unfinished tests')
  await call(tasks.restoreTasks, asAdmin({ body: { tasks: r._json.deleted } }))
  ok(await CoachAssignment.exists({ taskId: gone._id, status: 'pending' }), 'and Undo gives them back')
  ok(await CoachAssignment.exists({ _id: tAsg.id, status: 'completed' }), 'a passed test from a finished task is kept')
} catch (err) {
  fail++
  console.error('Smoke test crashed:', err)
} finally {
  await mongoose.connection.dropDatabase().catch(() => {})
  await mongoose.disconnect()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

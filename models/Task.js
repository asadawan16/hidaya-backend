import mongoose from 'mongoose'

// A to-do on the Tasks board. Assignees are portal users: staff, tutors, or a
// student's own account (e.g. "Revise Surah Al-Mulk for Friday's test").
// A task can be about a lead (call / follow-up / demo), a student, and count
// toward a weekly or monthly Goal.
// 'recurring' is a standing column: a task in it is looked at on its days
// (`recurDays`, every day when empty), and its assignees get a reminder on
// each of them (runTaskDueReminders). It is never "done"; moving it to Done
// ends it.
// 'review': an assignee who didn't create the task marked it done. The
// creator or a task.manage holder moves it to Done (or sends it back).
export const TASK_STATUSES = ['recurring', 'todo', 'in_progress', 'review', 'done']
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent']
export const TASK_TYPES = ['general', 'call', 'follow_up', 'demo', 'test', 'homework', 'meeting', 'admin', 'payment', 'other']

const checklistItemSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 300 },
  done: { type: Boolean, default: false },
}, { _id: true })

const commentSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 2000 },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: { type: String, trim: true, default: '' },
  mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  at: { type: Date, default: Date.now },
}, { _id: true })

// One line of the task's history ("Ali moved it to Done").
const activitySchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 300 },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: { type: String, trim: true, default: '' },
  at: { type: Date, default: Date.now },
}, { _id: false })

export const REPEAT_FREQS = ['daily', 'weekly', 'monthly']

const taskSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 5000, default: '' },
  type: { type: String, enum: TASK_TYPES, default: 'general' },
  status: { type: String, enum: TASK_STATUSES, default: 'todo' },
  priority: { type: String, enum: TASK_PRIORITIES, default: 'normal' },

  // Dates. All-day tasks store the day at 00:00 UTC (read as a date);
  // timed tasks (allDay false) store the instant.
  startDate: { type: Date },
  dueDate: { type: Date },
  allDay: { type: Boolean, default: true },

  assignees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Enrollment' },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
  goalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Goal' },

  checklist: { type: [checklistItemSchema], default: [] },
  comments: { type: [commentSchema], default: [] },
  // Newest last, capped at ACTIVITY_CAP entries
  activity: { type: [activitySchema], default: [] },
  // People who follow the task without doing it (added by an @mention):
  // they can open it and hear about comments.
  watchers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // Repeating task: finishing it creates the next one (utils/taskRepeat.js).
  repeat: {
    freq: { type: String, enum: ['', ...REPEAT_FREQS], default: '' },
    interval: { type: Number, min: 1, max: 52, default: 1 },
    weekdays: [{ type: Number, min: 0, max: 6 }], // weekly: 0 = Sunday
    monthDay: { type: Number, min: 1, max: 31 },  // monthly: the series' day, so a 31st survives February
    until: { type: Date },
  },
  repeatOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },      // the one before it
  repeatedInto: { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },  // the next one, once made

  // "Waiting on…": the task can't move until someone else does something.
  // A flag beside the status, so a waiting task keeps its column.
  waiting: {
    on: { type: Boolean, default: false },
    reason: { type: String, trim: true, maxlength: 300, default: '' },
    who: { type: String, trim: true, maxlength: 120, default: '' },       // "Parent", "Sara's mum"…
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },        // when it is someone in the portal
    since: { type: Date },
  },
  tags: [{ type: String, trim: true, maxlength: 40 }],

  // Reminders (client, 26 Nov 2026). A dated task reminds its assignees on
  // the due day, and also `daysBefore` days ahead when set; `off` sends none.
  // A Recurring-column task reminds at 7 PM PKT on each of its days.
  // `time` ('HH:MM', Pakistan time, client 27 Nov 2026) is when on those days
  // the reminder goes out; '' = the start of the day (7 PM for Recurring).
  reminder: {
    off: { type: Boolean, default: false },
    daysBefore: { type: Number, min: 0, max: 7, default: 0 },
    time: { type: String, default: '', match: /^(?:(?:[01]\d|2[0-3]):[0-5]\d)?$/ },
  },
  // Recurring column: the days of the week it is for (0 = Sunday). Empty =
  // every day. On other days it isn't reminded and has nothing to tick.
  recurDays: [{ type: Number, min: 0, max: 6 }],

  // An English Coach test the assignees must pass. Each assignee gets a
  // CoachAssignment (services/coachProgress.js#syncTaskTests), and the task
  // moves to Done by itself once every one of them has passed.
  coachTest: {
    type: new mongoose.Schema({
      scenarioKey: { type: String, required: true },
      scenarioTitle: { type: String, default: '' },
      difficulty: { type: String, enum: ['very_easy', 'easy', 'normal', 'hard'], required: true },
      durationMin: { type: Number },
      passScore: { type: Number, min: 0, max: 100, default: 0 },
    }, { _id: false }),
    default: undefined,
  },

  // Position inside its Kanban column (lower = higher up)
  order: { type: Number, default: 0 },

  completedAt: { type: Date },
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Who marked it done and sent it to Review, and when (a shared task has
  // several assignees; the reviewer is told which one).
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  submittedAt: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdByName: { type: String, trim: true, default: '' },

  // The due date the "due today" notification was last sent for, so moving
  // the date re-arms it.
  dueNotifiedFor: { type: Date },
  // The due date the early ("due in 2 days") reminder was last sent for.
  earlyNotifiedFor: { type: Date },
  // Recurring column: the shift day ('YYYY-MM-DD') the daily reminder was last
  // sent for, and the day an assignee last ticked "Checked today".
  dailyNotifiedOn: { type: String, default: '' },
  dailyCheckedOn: { type: String, default: '' },
  dailyCheckedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

taskSchema.index({ assignees: 1, status: 1 })
taskSchema.index({ dueDate: 1 })
taskSchema.index({ leadId: 1 })
taskSchema.index({ goalId: 1 })
taskSchema.index({ studentId: 1 })
taskSchema.index({ createdBy: 1 })
taskSchema.index({ watchers: 1 })
taskSchema.index({ status: 1, completedAt: -1 })
taskSchema.index({ 'waiting.userId': 1 })

export const ACTIVITY_CAP = 100

export default mongoose.model('Task', taskSchema)

import mongoose from 'mongoose'

// A to-do on the Tasks board. Assignees are portal users: staff, tutors, or a
// student's own account (e.g. "Revise Surah Al-Mulk for Friday's test").
// A task can be about a lead (call / follow-up / demo), a student, and count
// toward a weekly or monthly Goal.
// 'recurring' is a standing column: a task in it is looked at every day, and
// its assignees get a reminder each day (runTaskDueReminders). It is never
// "done"; moving it to Done ends it.
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

  // Position inside its Kanban column (lower = higher up)
  order: { type: Number, default: 0 },

  completedAt: { type: Date },
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdByName: { type: String, trim: true, default: '' },

  // The due date the "due today" notification was last sent for, so moving
  // the date re-arms it.
  dueNotifiedFor: { type: Date },
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

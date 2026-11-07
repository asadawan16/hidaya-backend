import mongoose from 'mongoose'

// A to-do on the Tasks board. Assignees are portal users: staff, tutors, or a
// student's own account (e.g. "Revise Surah Al-Mulk for Friday's test").
// A task can be about a lead (call / follow-up / demo), a student, and count
// toward a weekly or monthly Goal.
export const TASK_STATUSES = ['todo', 'in_progress', 'review', 'done']
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
  at: { type: Date, default: Date.now },
}, { _id: true })

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
}, { timestamps: true })

taskSchema.index({ assignees: 1, status: 1 })
taskSchema.index({ dueDate: 1 })
taskSchema.index({ leadId: 1 })
taskSchema.index({ goalId: 1 })
taskSchema.index({ studentId: 1 })
taskSchema.index({ createdBy: 1 })

export default mongoose.model('Task', taskSchema)

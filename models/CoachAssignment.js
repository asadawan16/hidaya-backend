import mongoose from 'mongoose'

/*
 * English Coach — one test given to one person: a scenario or script, at a
 * difficulty the assigner fixes, optionally with a call length and a pass mark.
 *
 * Made two ways, both handled in services/coachProgress.js:
 *   - the Assigned tests tab (POST /portal/coach/assignments), optionally with
 *     a task on the Tasks board for each person;
 *   - a task with an English test on it (Task.coachTest) — one assignment per
 *     assignee, kept in step with the task by syncTaskTests (`taskId` set).
 *
 * The tester starts it from their Practice tab (POST /sessions with
 * `assignmentId`), so the call carries `CoachSession.assignmentId`. When that
 * call is marked: attempts and the best score are recorded, and a score at or
 * above `passScore` (0 = any marked call) completes it — the assigner is told,
 * and a linked task is moved to Done once every assignee has passed.
 */
const coachAssignmentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  scenarioKey: { type: String, required: true },
  scenarioTitle: { type: String, default: '' },  // as it was when assigned (a part can be deleted later)
  difficulty: { type: String, enum: ['very_easy', 'easy', 'normal', 'hard'], required: true },
  durationMin: { type: Number },                  // absent = the tester chooses
  passScore: { type: Number, min: 0, max: 100, default: 0 },
  dueAt: { type: Date },
  note: { type: String, trim: true, maxlength: 500, default: '' },

  status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
  attempts: { type: Number, default: 0 },        // marked calls taken for it
  bestScore: { type: Number },
  lastSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoachSession' },
  lastAttemptAt: { type: Date },
  completedAt: { type: Date },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoachSession' }, // the call that completed it
  score: { type: Number },

  taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedByName: { type: String, default: '' },
}, { timestamps: true })

coachAssignmentSchema.index({ userId: 1, status: 1, createdAt: -1 })
coachAssignmentSchema.index({ status: 1, createdAt: -1 })
// One assignment per person per task
coachAssignmentSchema.index({ taskId: 1, userId: 1 }, { unique: true, partialFilterExpression: { taskId: { $exists: true } } })

export default mongoose.model('CoachAssignment', coachAssignmentSchema)

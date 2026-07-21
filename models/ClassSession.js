import mongoose from 'mongoose'

const classSessionSchema = new mongoose.Schema({
  slotId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ClassSlot',
  },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  tutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
    required: true,
  },
  date: { type: Date, required: true },
  scheduledStart: { type: String, required: true },
  scheduledEnd: { type: String, required: true },
  status: {
    type: String,
    enum: ['scheduled', 'started', 'completed', 'missed'],
    default: 'scheduled',
  },
  tutorStartedAt: { type: Date },
  actualStudentJoinTime: { type: Date },
  computedDuration: { type: Number },
  attendance: {
    type: String,
    enum: ['on_time', 'late', 'no_show', ''],
    default: '',
  },
  autoEndedAt: { type: Date },
  // Ended by the auto-complete job (ran >50 min) rather than by the tutor.
  autoCompleted: { type: Boolean, default: false },
  // Completed without lesson details (auto-completed or force-completed by oversight)
  // — the tutor is prompted to log the lesson afterwards. Cleared once a lesson is logged.
  needsLessonLog: { type: Boolean, default: false },
  lessonEntryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LessonEntry',
  },
  notes: { type: String, trim: true, default: '' },
}, { timestamps: true })

classSessionSchema.index({ date: 1, tutorId: 1 })
classSessionSchema.index({ date: 1, studentId: 1 })
classSessionSchema.index({ status: 1 })
classSessionSchema.index({ tutorId: 1, status: 1 })

export default mongoose.model('ClassSession', classSessionSchema)

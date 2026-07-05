import mongoose from 'mongoose'

const ackEntrySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  acknowledgedAt: { type: Date, default: Date.now },
}, { _id: false })

const noticeSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['teacher', 'student'],
    required: true,
  },
  category: {
    type: String,
    enum: ['permanent', 'urgent', 'temporary', 'information', 'student_specific'],
    default: 'information',
  },
  targetTutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
  },
  targetStudentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
  },
  targetStudentIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
  }],
  message: { type: String, required: true, trim: true },
  severity: {
    type: String,
    enum: ['info', 'warning', 'urgent'],
    default: 'info',
  },
  active: { type: Boolean, default: true },
  requiresAcknowledgment: { type: Boolean, default: false },
  acknowledgedBy: [ackEntrySchema],
  autoDisableAt: { type: Date },
  classTime: { type: String },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  // Keep legacy field for backward compat
  acknowledgedAt: { type: Date },
}, { timestamps: true })

noticeSchema.index({ type: 1, active: 1 })
noticeSchema.index({ targetTutorId: 1 })
noticeSchema.index({ targetStudentId: 1 })
noticeSchema.index({ category: 1, active: 1 })

export default mongoose.model('Notice', noticeSchema)

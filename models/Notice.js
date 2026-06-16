import mongoose from 'mongoose'

const noticeSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['teacher', 'student'],
    required: true,
  },
  targetTutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
  },
  targetStudentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
  },
  message: { type: String, required: true, trim: true },
  severity: {
    type: String,
    enum: ['info', 'warning', 'urgent'],
    default: 'info',
  },
  active: { type: Boolean, default: true },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  acknowledgedAt: { type: Date },
}, { timestamps: true })

noticeSchema.index({ type: 1, active: 1 })
noticeSchema.index({ targetTutorId: 1 })
noticeSchema.index({ targetStudentId: 1 })

export default mongoose.model('Notice', noticeSchema)

import mongoose from 'mongoose'

// A leave request belongs to a tutor (tutorId → TutorProfile) or to a management /
// support staff member (userId → User), mirroring Advance and TutorAttendance.
// Exactly one subject ref is set. Requests filed before staff leave existed have
// no subjectType stored — treat a missing value as 'tutor'.
const leaveRequestSchema = new mongoose.Schema({
  subjectType: { type: String, enum: ['tutor', 'staff'], default: 'tutor' },
  tutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  leaveType: {
    type: String,
    enum: ['sick', 'casual', 'emergency', 'personal', 'other'],
    required: true,
  },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  reason: { type: String, trim: true, required: true },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reviewedAt: { type: Date },
  reviewNotes: { type: String, trim: true, default: '' },
  totalDays: { type: Number, default: 1 },
}, { timestamps: true })

leaveRequestSchema.index({ tutorId: 1, status: 1 })
leaveRequestSchema.index({ userId: 1, status: 1 })
leaveRequestSchema.index({ status: 1, createdAt: -1 })

leaveRequestSchema.pre('validate', function(next) {
  // Keep subjectType and the subject ref in lockstep — a request with neither (or
  // both) would slip past every scoped query and show up in nobody's list.
  if (this.subjectType === 'staff') {
    if (!this.userId) return next(new Error('A staff leave request requires userId'))
    this.tutorId = undefined
  } else {
    this.subjectType = 'tutor'
    if (!this.tutorId) return next(new Error('A tutor leave request requires tutorId'))
    this.userId = undefined
  }
  next()
})

leaveRequestSchema.pre('save', function(next) {
  if (this.startDate && this.endDate) {
    const diff = this.endDate.getTime() - this.startDate.getTime()
    this.totalDays = Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)) + 1)
  }
  next()
})

export default mongoose.model('LeaveRequest', leaveRequestSchema)

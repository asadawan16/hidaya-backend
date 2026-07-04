import mongoose from 'mongoose'

const leaveRequestSchema = new mongoose.Schema({
  tutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
    required: true,
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
leaveRequestSchema.index({ status: 1, createdAt: -1 })

leaveRequestSchema.pre('save', function(next) {
  if (this.startDate && this.endDate) {
    const diff = this.endDate.getTime() - this.startDate.getTime()
    this.totalDays = Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)) + 1)
  }
  next()
})

export default mongoose.model('LeaveRequest', leaveRequestSchema)

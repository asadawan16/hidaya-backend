import mongoose from 'mongoose'

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  type: {
    type: String,
    enum: ['assignment', 'admission', 'lesson_approved', 'lesson_rejected', 'class_start', 'notice', 'complaint', 'chat', 'system', 'certificate_issued', 'employee_of_month', 'salary_paid', 'advance_created', 'leave_request', 'leave_approved', 'leave_rejected', 'badge_awarded'],
    required: true,
  },
  title: { type: String, required: true, trim: true },
  body: { type: String, trim: true, default: '' },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  readAt: { type: Date },
}, { timestamps: true })

notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 })

export default mongoose.model('Notification', notificationSchema)

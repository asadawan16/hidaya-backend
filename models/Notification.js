import mongoose from 'mongoose'

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  type: {
    type: String,
    enum: ['assignment', 'admission', 'lesson_submitted', 'lesson_approved', 'lesson_rejected', 'class_start', 'session_missed', 'notice', 'complaint', 'chat', 'chat_message', 'chat_mention', 'system', 'certificate_issued', 'employee_of_month', 'invoice_created', 'invoice_paid', 'salary_generated', 'salary_paid', 'salary_increment', 'advance_created', 'advance_updated', 'advance_requested', 'advance_approved', 'advance_rejected', 'leave_request', 'leave_approved', 'leave_rejected', 'tutor_change_requested', 'tutor_change_approved', 'tutor_change_rejected', 'badge_awarded', 'assessment_recorded', 'user_account', 'demo_assigned'],
    required: true,
  },
  title: { type: String, required: true, trim: true },
  body: { type: String, trim: true, default: '' },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  readAt: { type: Date },
}, { timestamps: true })

notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 })

export default mongoose.model('Notification', notificationSchema)

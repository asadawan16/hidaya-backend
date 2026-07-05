import mongoose from 'mongoose'

const whatsappReminderLogSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  tutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
  },
  sentDate: { type: Date, required: true },
  sentBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true })

// Enforce once per student per day
whatsappReminderLogSchema.index({ studentId: 1, sentDate: 1 }, { unique: true })

export default mongoose.model('WhatsappReminderLog', whatsappReminderLogSchema)

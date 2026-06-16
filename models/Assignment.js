import mongoose from 'mongoose'

const assignmentSchema = new mongoose.Schema({
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
  track: {
    type: String,
    enum: ['nazra', 'hifz', 'tafseer', 'tajweed', 'translation', 'qaida'],
    required: true,
  },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, default: null },
  reason: { type: String, trim: true, default: '' },
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true })

// Current tutor = active assignment (endDate: null)
assignmentSchema.index({ studentId: 1, endDate: 1 })
assignmentSchema.index({ tutorId: 1, endDate: 1 })
assignmentSchema.index({ studentId: 1, track: 1, endDate: 1 })

export default mongoose.model('Assignment', assignmentSchema)

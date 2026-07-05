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
  type: {
    type: String,
    enum: ['permanent', 'temporary'],
    default: 'permanent',
  },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, default: null },
  reason: { type: String, trim: true, default: '' },
  replacesAssignmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Assignment',
  },
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvalStatus: { type: String, enum: ['auto_approved', 'pending_approval', 'approved', 'rejected'], default: 'auto_approved' },
  approvalNote: { type: String, trim: true, default: '' },
}, { timestamps: true })

// Current tutor = active assignment (endDate: null)
assignmentSchema.index({ studentId: 1, endDate: 1 })
assignmentSchema.index({ tutorId: 1, endDate: 1 })
assignmentSchema.index({ studentId: 1, track: 1, endDate: 1 })

export default mongoose.model('Assignment', assignmentSchema)

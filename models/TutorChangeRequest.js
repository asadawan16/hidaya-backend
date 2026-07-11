import mongoose from 'mongoose'

// A request (by a QCI or a student) to change a student's tutor for a track.
// A QCM or super_admin/admin reviews it. On approval the current active assignment
// for that student+track is closed (becomes a past tutor) and the selected new
// tutor is assigned.
const tutorChangeRequestSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  track: {
    type: String,
    enum: ['nazra', 'hifz', 'tafseer', 'tajweed', 'translation', 'qaida'],
    required: true,
  },
  fromTutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile' }, // current tutor (may be null)
  toTutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile', required: true }, // requested new tutor
  reason: { type: String, trim: true, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  requestedByRole: { type: String, trim: true, default: '' }, // 'qci' | 'student' | ...
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  reviewNotes: { type: String, trim: true, default: '' },
  // The assignment created on approval (for traceability)
  resultingAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' },
}, { timestamps: true })

tutorChangeRequestSchema.index({ status: 1, createdAt: -1 })
tutorChangeRequestSchema.index({ studentId: 1, status: 1 })

export default mongoose.model('TutorChangeRequest', tutorChangeRequestSchema)

import mongoose from 'mongoose'

const complaintSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  representative: {
    type: String,
    enum: ['principal', 'hqci', 'hqcm', 'admin', 'coordinator'],
    required: true,
  },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  againstTutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
  },
  complainant: {
    type: String,
    enum: ['father', 'mother', 'student', 'grandfather', 'grandmother', 'uncle', 'aunty', 'brother', 'sister', 'other'],
    required: true,
  },
  text: { type: String, required: true, trim: true },
  visibility: {
    type: String,
    enum: ['teacher_only', 'all_staff'],
    default: 'teacher_only',
  },
  status: {
    type: String,
    enum: ['open', 'resolved', 'dismissed'],
    default: 'open',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  resolvedAt: { type: Date },
  resolution: { type: String, trim: true, default: '' },
}, { timestamps: true })

complaintSchema.index({ studentId: 1 })
complaintSchema.index({ againstTutorId: 1 })
complaintSchema.index({ status: 1 })

export default mongoose.model('Complaint', complaintSchema)

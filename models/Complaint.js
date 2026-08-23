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
  // Display formatting for the message — an admin can bump the size / bold it so
  // less-literate staff can read it easily (applied to the whole message).
  fontSize: {
    type: String,
    enum: ['sm', 'base', 'lg', 'xl'],
    default: 'base',
  },
  bold: { type: Boolean, default: false },
  // Who may read this complaint. `management_only` keeps it away from tutors
  // entirely (enforced in listComplaints + the student-progress detail) — used
  // when the complaint is about a tutor and shouldn't reach them.
  visibility: {
    type: String,
    enum: ['teacher_only', 'all_staff', 'management_only'],
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
  actionRequired: { type: String, trim: true, default: '' },
  category: {
    type: String,
    enum: ['parent_complaint', 'admin_feedback', 'quality_issue', 'behavior', 'attendance', 'general'],
    default: 'general',
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
  },
}, { timestamps: true })

complaintSchema.index({ studentId: 1 })
complaintSchema.index({ againstTutorId: 1 })
complaintSchema.index({ status: 1 })

export default mongoose.model('Complaint', complaintSchema)

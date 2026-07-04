import mongoose from 'mongoose'

const certificateSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  type: {
    type: String,
    enum: [
      'qaida_completion', 'para_completion', 'juz_completion',
      'hifz_completion', 'course_completion', 'tajweed_completion',
      'assessment_excellence', 'attendance_excellence', 'custom',
    ],
    required: true,
  },
  title: { type: String, required: true, trim: true },
  details: { type: String, trim: true, default: '' },
  templateDesign: {
    type: String,
    enum: ['classic', 'modern', 'ornate', 'minimal', 'crimson', 'emerald', 'sapphire', 'noir'],
    default: 'classic',
  },
  // Approval workflow
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  submittedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedAt: { type: Date },
  rejectionReason: { type: String, trim: true, default: '' },
  acknowledgedAt: { type: Date },
  issuedDate: { type: Date, default: Date.now },
  // Legacy field — kept for backwards compat, same as submittedBy
  issuedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  meta: {
    trackCompleted: String,
    itemsCompleted: Number,
    assessmentScore: Number,
    customFields: mongoose.Schema.Types.Mixed,
  },
}, { timestamps: true })

certificateSchema.index({ studentId: 1, type: 1 })
certificateSchema.index({ issuedDate: -1 })
certificateSchema.index({ status: 1 })

export default mongoose.model('Certificate', certificateSchema)

import mongoose from 'mongoose'

const badgeSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  badgeType: {
    type: String,
    enum: [
      'quran_star', 'fast_learner', 'perfect_attendance', 'top_performer',
      'consistency', 'helping_hand', 'best_recitation', 'memory_master',
      'discipline', 'most_improved', 'class_leader', 'effort_award',
    ],
    required: true,
  },
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: '' },
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
}, { timestamps: true })

badgeSchema.index({ studentId: 1, status: 1 })
badgeSchema.index({ status: 1, createdAt: -1 })

export default mongoose.model('Badge', badgeSchema)

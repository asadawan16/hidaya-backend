import mongoose from 'mongoose'

const studentStatusHistorySchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  status: {
    type: String,
    enum: ['active', 'leave', 'left', 'pending'],
    required: true,
  },
  effectiveDate: { type: Date, default: Date.now },
  comment: { type: String, trim: true, default: '' },
  changedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true })

studentStatusHistorySchema.index({ studentId: 1, createdAt: -1 })

export default mongoose.model('StudentStatusHistory', studentStatusHistorySchema)

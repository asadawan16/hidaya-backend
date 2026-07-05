import mongoose from 'mongoose'

const studentRelationshipSchema = new mongoose.Schema({
  studentA: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  studentB: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  type: {
    type: String,
    enum: ['sibling', 'cousin', 'other'],
    required: true,
  },
  note: { type: String, trim: true, default: '' },
}, { timestamps: true })

studentRelationshipSchema.index({ studentA: 1 })
studentRelationshipSchema.index({ studentB: 1 })

export default mongoose.model('StudentRelationship', studentRelationshipSchema)

import mongoose from 'mongoose'

const studentSchema = new mongoose.Schema({
  rollNo: { type: String, trim: true, default: '' },
  name: { type: String, required: true, trim: true },
  email: { type: String, lowercase: true, trim: true, default: '' },
  phone: { type: String, trim: true },
  notes: { type: String, trim: true },
}, { timestamps: true })

studentSchema.index({ rollNo: 1 }, { sparse: true })
studentSchema.index({ email: 1 }, { sparse: true })
studentSchema.index({ name: 1 })
studentSchema.index({ createdAt: -1 })

export default mongoose.model('Student', studentSchema)

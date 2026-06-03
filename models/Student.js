import mongoose from 'mongoose'

const studentSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  notes: { type: String, trim: true },
}, { timestamps: true })

studentSchema.index({ email: 1 })
studentSchema.index({ name: 1 })
studentSchema.index({ createdAt: -1 })

export default mongoose.model('Student', studentSchema)

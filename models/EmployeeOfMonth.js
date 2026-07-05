import mongoose from 'mongoose'

const employeeOfMonthSchema = new mongoose.Schema({
  tutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile', required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  year: { type: Number, required: true },
  reason: { type: String, trim: true, default: '' },
  awardedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acknowledgedAt: { type: Date, default: null },
}, { timestamps: true })

employeeOfMonthSchema.index({ year: 1, month: 1 }, { unique: true })

export default mongoose.model('EmployeeOfMonth', employeeOfMonthSchema)

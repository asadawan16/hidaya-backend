import mongoose from 'mongoose'

const salaryIncrementSchema = new mongoose.Schema({
  tutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
    required: true,
  },
  previousAmount: { type: Number, required: true },
  newAmount: { type: Number, required: true },
  incrementAmount: { type: Number, required: true },
  incrementPercentage: { type: Number, required: true },
  currency: {
    type: String,
    enum: ['PKR', 'USD', 'EUR', 'GBP', 'CAD'],
    default: 'PKR',
  },
  effectiveDate: { type: Date, required: true },
  reason: { type: String, trim: true, default: '' },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true })

salaryIncrementSchema.index({ tutorId: 1, effectiveDate: -1 })

export default mongoose.model('SalaryIncrement', salaryIncrementSchema)

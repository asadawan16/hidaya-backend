import mongoose from 'mongoose'

// Staff-side mirror of SalaryIncrement (which is tutor-only). Tracks base-salary
// raises for management/support staff over time, keyed to the portal User.
const staffSalaryIncrementSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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

staffSalaryIncrementSchema.index({ userId: 1, effectiveDate: -1 })

export default mongoose.model('StaffSalaryIncrement', staffSalaryIncrementSchema)

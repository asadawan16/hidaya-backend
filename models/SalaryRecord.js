import mongoose from 'mongoose'

const deductionSchema = new mongoose.Schema({
  reason: { type: String, required: true, trim: true },
  amount: { type: Number, required: true },
}, { _id: true })

const salaryRecordSchema = new mongoose.Schema({
  tutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
    required: true,
  },
  month: { type: Number, required: true, min: 1, max: 12 },
  year: { type: Number, required: true },
  baseAmount: { type: Number, required: true },
  currency: {
    type: String,
    enum: ['PKR', 'USD', 'EUR', 'GBP'],
    default: 'PKR',
  },
  deductions: [deductionSchema],
  totalDeductions: { type: Number, default: 0 },
  bonuses: { type: Number, default: 0 },
  netPayable: { type: Number, required: true },
  presentDays: { type: Number, default: 0 },
  absentDays: { type: Number, default: 0 },
  totalHours: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['draft', 'finalized', 'paid'],
    default: 'draft',
  },
  notes: { type: String, trim: true, default: '' },
  generatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true })

salaryRecordSchema.index({ tutorId: 1, year: 1, month: 1 }, { unique: true })

export default mongoose.model('SalaryRecord', salaryRecordSchema)

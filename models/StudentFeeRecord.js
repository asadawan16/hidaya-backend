import mongoose from 'mongoose'

// One cell in the yearly fee grid: a student's fee status for a given month.
// Manually managed (bank transfers / cash / mixed modes aren't auto-captured),
// optionally linked to a FeePayment that covered it.
const studentFeeRecordSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family' }, // denormalized for grouping
  year: { type: Number, required: true },
  month: { type: Number, required: true, min: 1, max: 12 },

  amount: { type: Number, default: 0 },      // agreed/expected fee for the month
  amountPaid: { type: Number, default: 0 },  // total received against this month
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], default: 'PKR' },

  status: {
    type: String,
    enum: ['pending', 'received', 'partial', 'waived'],
    default: 'pending',
  },

  // The fee payment(s) that contributed to this month (most recent last)
  payments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FeePayment' }],
  method: { type: String, trim: true, default: '' }, // denormalized last method
  note: { type: String, trim: true, default: '' },
  paidAt: { type: Date },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

// One record per student per month per year
studentFeeRecordSchema.index({ studentId: 1, year: 1, month: 1 }, { unique: true })
studentFeeRecordSchema.index({ year: 1, month: 1 })
studentFeeRecordSchema.index({ familyId: 1, year: 1 })

export default mongoose.model('StudentFeeRecord', studentFeeRecordSchema)

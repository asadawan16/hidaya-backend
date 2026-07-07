import mongoose from 'mongoose'

// A single received payment, manually recorded. One payment can be allocated
// across many months and many students (family relations), e.g. "one transfer
// of 6000 covering 3 months for 2 siblings". Can optionally wrap an existing
// gateway Payment (linkedPaymentId) to bring card/online payments into the grid.
const allocationSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  year: { type: Number, required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  amount: { type: Number, default: 0 },
}, { _id: true })

const feePaymentSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], default: 'PKR' },
  method: {
    type: String,
    enum: ['bank_transfer', 'cash', 'card', 'jazzcash', 'easypaisa', 'cheque', 'other'],
    default: 'bank_transfer',
  },
  reference: { type: String, trim: true, default: '' }, // bank ref / txn id / cheque no
  payerName: { type: String, trim: true, default: '' },
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family' },
  paidAt: { type: Date, default: Date.now },

  // If this wraps an existing gateway Payment (card/online)
  linkedPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },

  allocations: [allocationSchema],

  note: { type: String, trim: true, default: '' },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

feePaymentSchema.index({ 'allocations.studentId': 1 })
feePaymentSchema.index({ familyId: 1 })
feePaymentSchema.index({ linkedPaymentId: 1 })
feePaymentSchema.index({ paidAt: -1 })

export default mongoose.model('FeePayment', feePaymentSchema)

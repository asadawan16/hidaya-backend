import mongoose from 'mongoose'

const installmentSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  amount: { type: Number, required: true },
  salaryRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'SalaryRecord' },
  note: { type: String, trim: true, default: '' },
}, { _id: true })

const advanceSchema = new mongoose.Schema({
  tutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile', required: true },
  type: { type: String, enum: ['short_term', 'long_term'], required: true },
  totalAmount: { type: Number, required: true },
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP', 'CAD'], default: 'PKR' },
  installmentAmount: { type: Number, required: true },
  installmentFrequency: { type: String, enum: ['weekly', 'monthly'], default: 'monthly' },
  amountRepaid: { type: Number, default: 0 },
  remainingBalance: { type: Number },
  installments: [installmentSchema],
  status: { type: String, enum: ['requested', 'active', 'fully_paid', 'cancelled', 'rejected'], default: 'active' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  rejectionReason: { type: String, trim: true, default: '' },
  reason: { type: String, trim: true, default: '' },
  startDate: { type: Date, required: true },
}, { timestamps: true })

advanceSchema.index({ tutorId: 1, status: 1 })

advanceSchema.pre('save', function(next) {
  this.remainingBalance = this.totalAmount - this.amountRepaid
  // Only auto-complete an active repaying advance — never a requested/rejected/cancelled one.
  if (this.status === 'active' && this.remainingBalance <= 0) {
    this.remainingBalance = 0
    this.status = 'fully_paid'
  }
  if (this.remainingBalance < 0) this.remainingBalance = 0
  next()
})

export default mongoose.model('Advance', advanceSchema)

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
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], default: 'PKR' },
  installmentAmount: { type: Number, required: true },
  installmentFrequency: { type: String, enum: ['weekly', 'monthly'], default: 'monthly' },
  amountRepaid: { type: Number, default: 0 },
  remainingBalance: { type: Number },
  installments: [installmentSchema],
  status: { type: String, enum: ['active', 'fully_paid', 'cancelled'], default: 'active' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reason: { type: String, trim: true, default: '' },
  startDate: { type: Date, required: true },
}, { timestamps: true })

advanceSchema.index({ tutorId: 1, status: 1 })

advanceSchema.pre('save', function(next) {
  this.remainingBalance = this.totalAmount - this.amountRepaid
  if (this.remainingBalance <= 0) {
    this.remainingBalance = 0
    this.status = 'fully_paid'
  }
  next()
})

export default mongoose.model('Advance', advanceSchema)

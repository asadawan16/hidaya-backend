import mongoose from 'mongoose'

const installmentSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  amount: { type: Number, required: true },
  salaryRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'SalaryRecord' },
  note: { type: String, trim: true, default: '' },
}, { _id: true })

// An advance belongs to a tutor (tutorId → TutorProfile) or to a management /
// support staff member (userId → User), mirroring SalaryRecord.subjectType so
// payroll can deduct repayments for either. Exactly one subject ref is set.
const advanceSchema = new mongoose.Schema({
  subjectType: { type: String, enum: ['tutor', 'staff'], default: 'tutor' },
  tutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
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
advanceSchema.index({ userId: 1, status: 1 })
advanceSchema.index({ subjectType: 1, status: 1 })

advanceSchema.pre('validate', function(next) {
  // Keep subjectType and the subject ref in lockstep — a record with neither (or
  // both) would slip past every scoped query and silently vanish from payroll.
  if (this.subjectType === 'staff') {
    if (!this.userId) return next(new Error('A staff advance requires userId'))
    this.tutorId = undefined
  } else {
    this.subjectType = 'tutor'
    if (!this.tutorId) return next(new Error('A tutor advance requires tutorId'))
    this.userId = undefined
  }
  next()
})

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

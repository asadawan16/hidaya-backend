import mongoose from 'mongoose'

// Fee Tracker (/portal/fee-tracker) — the office's monthly fee-chasing list,
// the portal's version of the client's "Hidaya Receivables" sheet. One row per
// family (or student with no family) per month: whether a payment link /
// reminder went out, whether the row is ignored this month, and the expected
// amount when it was typed over. Every month starts clean (no row = not sent,
// not ignored, expected = what the portal says is owed).
//
// Deliberately separate from StudentFeeRecord / FeePayment: the tracker READS
// the Fee Management data and never writes it.
const feeTrackerEntrySchema = new mongoose.Schema({
  year: { type: Number, required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  // 'f:<familyId>' for a family, 's:<studentId>' for a student with no family.
  groupKey: { type: String, required: true, trim: true },
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family' },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },

  linkSent: { type: Boolean, default: false },
  linkSentAt: { type: Date },
  ignored: { type: Boolean, default: false },
  // null = use the amount the portal computes; a number = typed by the office.
  expected: { type: Number, default: null, min: 0 },
  note: { type: String, trim: true, default: '', maxlength: 500 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

feeTrackerEntrySchema.index({ year: 1, month: 1, groupKey: 1 }, { unique: true })

export default mongoose.model('FeeTrackerEntry', feeTrackerEntrySchema)

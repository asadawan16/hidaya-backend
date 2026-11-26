import mongoose from 'mongoose'

// A payment marked received on the Fee Tracker, and the receipt it prints.
// One payment can cover several students (a family, plus anyone else's fee
// sent along with it) and several months each. Names and roll numbers are
// snapshotted so an old receipt reprints the same after a student is renamed.
//
// Like FeeTrackerEntry, this never touches StudentFeeRecord / FeePayment — the
// months it covers count as settled on the Fee Tracker only.
const monthSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
}, { _id: false })

const lineSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  name: { type: String, trim: true, default: '' },
  rollNo: { type: String, trim: true, default: '' },
  months: { type: [monthSchema], default: [] },
  amount: { type: Number, default: 0, min: 0 },
  // What the printed receipt shows for this line: the amount in the student's
  // own billing currency, worked out from the rupee amount with the student's
  // rate (billed amount / local fee) when the payment was saved (client,
  // 27 Nov 2026). Older receipts have neither; they are worked out on read.
  billedCurrency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP', 'CAD'] },
  billedAmount: { type: Number, min: 0 },
}, { _id: false })

const feeTrackerReceiptSchema = new mongoose.Schema({
  receiptNo: { type: String, required: true, unique: true, trim: true },
  // The tracker month (and row) the payment was marked from.
  year: { type: Number, required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  groupKey: { type: String, required: true, trim: true },
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family' },
  familyCode: { type: String, trim: true, default: '' },

  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP', 'CAD'], default: 'PKR' },
  mode: { type: String, trim: true, default: '', maxlength: 60 }, // SC, Wise, EasyPaisa… (the sheet's "Mode")
  paidAt: { type: Date, default: Date.now },
  payerName: { type: String, trim: true, default: '', maxlength: 120 },
  reference: { type: String, trim: true, default: '', maxlength: 120 },
  note: { type: String, trim: true, default: '', maxlength: 500 },

  lines: { type: [lineSchema], default: [] },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

feeTrackerReceiptSchema.index({ year: 1, month: 1 })
feeTrackerReceiptSchema.index({ 'lines.studentId': 1 })

export default mongoose.model('FeeTrackerReceipt', feeTrackerReceiptSchema)

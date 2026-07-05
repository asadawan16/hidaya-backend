import mongoose from 'mongoose'

const invoiceItemSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true },
  amount: { type: Number, required: true },
  quantity: { type: Number, default: 1 },
}, { _id: true })

const invoiceSchema = new mongoose.Schema({
  invoiceNo: { type: String, unique: true, trim: true },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  items: [invoiceItemSchema],
  amount: { type: Number, required: true },
  currency: {
    type: String,
    enum: ['PKR', 'USD', 'EUR', 'GBP'],
    default: 'PKR',
  },
  dueDate: { type: Date },
  status: {
    type: String,
    enum: ['draft', 'sent', 'paid', 'partially_paid', 'overdue', 'cancelled'],
    default: 'draft',
  },
  paidAmount: { type: Number, default: 0 },
  payments: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment',
  }],
  notes: { type: String, trim: true, default: '' },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true })

invoiceSchema.index({ studentId: 1 })
invoiceSchema.index({ status: 1 })
invoiceSchema.index({ dueDate: 1 })

export default mongoose.model('Invoice', invoiceSchema)

import mongoose from 'mongoose'
import crypto from 'crypto'

const paymentLinkSchema = new mongoose.Schema({
  // Payee info
  payeeName: { type: String, required: true, trim: true },
  payeeEmail: { type: String, lowercase: true, trim: true, default: '' },
  payeePhone: { type: String, trim: true },

  // Payment details
  description: { type: String, required: true, trim: true },
  amount: { type: Number, required: true },
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], default: 'PKR' },

  // Unique token for the link
  token: {
    type: String,
    unique: true,
    default: () => crypto.randomBytes(24).toString('hex'),
  },

  // Status — only expires on successful payment
  status: {
    type: String,
    enum: ['active', 'completed', 'failed'],
    default: 'active',
  },

  // Invoice number — auto-generated, updated on each payment for recurring links
  invoiceNo: { type: String, trim: true, default: '' },

  // Linked payment (most recent — created when user clicks Pay Now)
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },

  // All payments made on this link (for recurring/reusable links)
  payments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }],

  // Line items shown on the payment page
  items: [{ type: String, trim: true }],
  listType: { type: String, enum: ['bullet', 'numbered'], default: 'bullet' },

  // Optional linked student
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },

  // Admin notes
  notes: { type: String, trim: true },

  // Whether the link expires (becomes unusable) after successful payment
  expiresAfterPayment: { type: Boolean, default: true },

  // Whether email was sent
  emailSent: { type: Boolean, default: false },
}, { timestamps: true })

paymentLinkSchema.index({ token: 1 })
paymentLinkSchema.index({ status: 1 })
paymentLinkSchema.index({ createdAt: -1 })
paymentLinkSchema.index({ payeeEmail: 1 })
paymentLinkSchema.index({ student: 1 })

export default mongoose.model('PaymentLink', paymentLinkSchema)

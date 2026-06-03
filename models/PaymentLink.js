import mongoose from 'mongoose'
import crypto from 'crypto'

const paymentLinkSchema = new mongoose.Schema({
  // Payee info
  payeeName: { type: String, required: true, trim: true },
  payeeEmail: { type: String, required: true, lowercase: true, trim: true },
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

  // Linked payment (created when user clicks Pay Now)
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },

  // Line items shown on the payment page
  items: [{ type: String, trim: true }],
  listType: { type: String, enum: ['bullet', 'numbered'], default: 'bullet' },

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

export default mongoose.model('PaymentLink', paymentLinkSchema)

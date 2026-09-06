import mongoose from 'mongoose'

const paymentSchema = new mongoose.Schema({
  // Student info
  studentName: { type: String, required: true, trim: true },
  studentEmail: { type: String, lowercase: true, trim: true, default: '' },
  studentPhone: { type: String, trim: true },

  // Plan info
  plan: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP', 'CAD'], default: 'PKR' },

  // Payment method used
  paymentMethod: { type: String, enum: ['CARD', 'PAYPAL', 'STRIPE'], default: 'CARD' },

  // Which processor handled this payment
  gateway: { type: String, enum: ['mastercard', 'stripe'], default: 'mastercard' },

  // Gateway response (NO card details stored). `gatewayOrderId` is our own
  // reference and is set for both processors, so lookups stay uniform.
  gatewayOrderId: { type: String },
  gatewayTransactionId: { type: String },
  gatewayResult: { type: String }, // SUCCESS, FAILURE, PENDING
  gatewayResultCode: { type: String },

  // Stripe references (gateway === 'stripe')
  stripeSessionId: { type: String, default: '' },
  stripePaymentIntentId: { type: String, default: '' },
  // No default — the field must stay ABSENT on non-Stripe payments so the
  // partial unique index below only ever covers real Stripe invoices.
  stripeInvoiceId: { type: String },
  stripeSubscriptionId: { type: String, default: '' },
  // subscription_create = first cycle · subscription_cycle = a renewal charge
  billingReason: { type: String, default: '' },

  // Invoice number — copied from payment link
  invoiceNo: { type: String, trim: true, default: '' },

  // Status
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded', 'expired'],
    default: 'pending',
  },

  // Optional refs (set when payment originates from a payment link)
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
  paymentLink: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentLink' },

  // Discount code applied at payment time
  discountCode: { type: String, trim: true },
  discountCodeRef: { type: mongoose.Schema.Types.ObjectId, ref: 'DiscountCode' },
  discountAmount: { type: Number, default: 0 },
  originalAmount: { type: Number },

  // Tax applied at payment time (added on top of the post-discount subtotal)
  taxAmount: { type: Number, default: 0 },
  taxType: { type: String, enum: ['none', 'percentage', 'fixed'], default: 'none' },
  taxValue: { type: Number, default: 0 },

  // Multi-student support
  quantity: { type: Number, default: 1, min: 1 },
  studentNames: [{ type: String, trim: true }],

  // Notes
  notes: { type: String },
}, { timestamps: true })

paymentSchema.index({ studentEmail: 1 })
paymentSchema.index({ status: 1 })
paymentSchema.index({ createdAt: -1 })
paymentSchema.index({ student: 1 })
paymentSchema.index({ paymentLink: 1 })
paymentSchema.index({ stripeSessionId: 1 })
// Sparse-unique: one Payment per Stripe invoice, so a redelivered `invoice.paid`
// webhook can never double-record a subscription cycle.
// (partialFilterExpression and `sparse` are mutually exclusive in MongoDB — the
// partial filter alone is what keeps non-Stripe payments out of the index.)
paymentSchema.index({ stripeInvoiceId: 1 }, { unique: true, partialFilterExpression: { stripeInvoiceId: { $type: 'string' } } })

export default mongoose.model('Payment', paymentSchema)

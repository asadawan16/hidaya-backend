import mongoose from 'mongoose'

const paymentSchema = new mongoose.Schema({
  // Student info
  studentName: { type: String, required: true, trim: true },
  studentEmail: { type: String, lowercase: true, trim: true, default: '' },
  studentPhone: { type: String, trim: true },

  // Plan info
  plan: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], default: 'PKR' },

  // Payment method used
  paymentMethod: { type: String, enum: ['CARD', 'PAYPAL'], default: 'CARD' },

  // Mastercard gateway response (NO card details stored)
  gatewayOrderId: { type: String },
  gatewayTransactionId: { type: String },
  gatewayResult: { type: String }, // SUCCESS, FAILURE, PENDING
  gatewayResultCode: { type: String },

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

export default mongoose.model('Payment', paymentSchema)

import mongoose from 'mongoose'

const paymentSchema = new mongoose.Schema({
  // Student info
  studentName: { type: String, required: true, trim: true },
  studentEmail: { type: String, required: true, lowercase: true, trim: true },
  studentPhone: { type: String, trim: true },

  // Plan info
  plan: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'USD' },

  // Mastercard gateway response (NO card details stored)
  gatewayOrderId: { type: String },
  gatewayTransactionId: { type: String },
  gatewayResult: { type: String }, // SUCCESS, FAILURE, PENDING
  gatewayResultCode: { type: String },

  // Status
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded'],
    default: 'pending',
  },

  // Notes
  notes: { type: String },
}, { timestamps: true })

paymentSchema.index({ studentEmail: 1 })
paymentSchema.index({ status: 1 })
paymentSchema.index({ createdAt: -1 })

export default mongoose.model('Payment', paymentSchema)

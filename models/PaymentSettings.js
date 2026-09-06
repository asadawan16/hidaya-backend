import mongoose from 'mongoose'

/*
 * Singleton settings row (key: 'default') for the public checkout surfaces.
 *
 * `feeGateway` is the processor the public fee page (/fee) sends plan
 * purchases through. Payment links are unaffected — each of those picks its
 * own processor at creation time (PaymentLink.gateway).
 */
const paymentSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  feeGateway: { type: String, enum: ['mastercard', 'stripe'], default: 'mastercard' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
}, { timestamps: true })

export default mongoose.model('PaymentSettings', paymentSettingsSchema)

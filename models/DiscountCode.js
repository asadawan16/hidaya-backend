import mongoose from 'mongoose'
import crypto from 'crypto'

const discountCodeSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    default: () => crypto.randomBytes(4).toString('hex').toUpperCase(),
  },
  discountAmount: { type: Number, required: true },
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], required: true },
  // one_time: expires after a single successful use
  // recurring: can be used unlimited times
  usageType: { type: String, enum: ['one_time', 'recurring'], default: 'one_time' },
  timesUsed: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  description: { type: String, trim: true },
}, { timestamps: true })

discountCodeSchema.index({ code: 1 })
discountCodeSchema.index({ isActive: 1 })
discountCodeSchema.index({ currency: 1 })

export default mongoose.model('DiscountCode', discountCodeSchema)

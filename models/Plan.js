import mongoose from 'mongoose'

const planSchema = new mongoose.Schema({
  planId: { type: String, required: true, unique: true },  // e.g. '2-days'
  name: { type: String, required: true },
  sessions: { type: String, required: true },
  duration: { type: String, required: true },
  price: { type: Number, required: true, min: 20 },
  prices: {
    PKR: { type: Number },
    USD: { type: Number },
    EUR: { type: Number },
    GBP: { type: Number },
  },
  defaultCurrency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], default: 'PKR' },
  features: [{ type: String }],
  popular: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
}, { timestamps: true })

export default mongoose.model('Plan', planSchema)

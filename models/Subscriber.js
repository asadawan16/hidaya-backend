import mongoose from 'mongoose'

const subscriberSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  status: {
    type: String,
    enum: ['active', 'unsubscribed'],
    default: 'active',
  },
}, { timestamps: true })

subscriberSchema.index({ status: 1 })
subscriberSchema.index({ createdAt: -1 })

export default mongoose.model('Subscriber', subscriberSchema)

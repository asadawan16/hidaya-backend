import mongoose from 'mongoose'

const logSchema = new mongoose.Schema({
  level: { type: String, enum: ['info', 'warning', 'error'], default: 'info' },
  category: {
    type: String,
    enum: ['auth', 'payment', 'enrollment', 'payment_link', 'student', 'discount_code', 'blog', 'subscriber', 'system', 'portal', 'user_management', 'role_management', 'mfa'],
    required: true,
  },
  action: { type: String, required: true },
  message: { type: String, required: true },
  method: String,
  path: String,
  statusCode: Number,
  duration: Number,
  ip: String,
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  meta: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true })

// Auto-delete logs older than 90 days
logSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 })
logSchema.index({ level: 1 })
logSchema.index({ category: 1 })

export default mongoose.model('Log', logSchema)

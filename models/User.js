import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
    minlength: 6,
  },
  displayName: {
    type: String,
    required: true,
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
    default: '',
  },
  avatar: {
    type: String,
    trim: true,
    default: '',
  },
  bio: {
    type: String,
    trim: true,
    default: '',
  },
  roles: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Role',
    required: true,
  }],
  status: {
    type: String,
    enum: ['active', 'suspended', 'pending'],
    default: 'active',
  },
  mfa: {
    enabled: { type: Boolean, default: false },
    secretEnc: { type: String, default: '' },
    enrolledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    enrolledAt: { type: Date },
  },
  mustLoginWithinShift: {
    type: Boolean,
    default: false,
  },
  passwordReset: {
    otpHash: { type: String, default: '' },
    expiresAt: { type: Date },
    attempts: { type: Number, default: 0 },
  },
  lastLoginAt: {
    type: Date,
  },
  linkedStudentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    sparse: true,
  },
  linkedTutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
    sparse: true,
  },
  linkedStaffId: {
    type: mongoose.Schema.Types.ObjectId,
    sparse: true,
  },
  // Registered mobile push tokens (Expo push tokens). Populated by the mobile
  // app via /portal/notifications/register-device. Used by services/push.js.
  pushTokens: [{
    token: { type: String, required: true },
    platform: { type: String, enum: ['ios', 'android'], default: 'android' },
    deviceId: { type: String, default: '' },
    lastSeenAt: { type: Date, default: Date.now },
    _id: false,
  }],
}, { timestamps: true })

userSchema.index({ status: 1 })

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next()
  this.password = await bcrypt.hash(this.password, 12)
  next()
})

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password)
}

// Never return password in JSON
userSchema.methods.toJSON = function () {
  const obj = this.toObject()
  delete obj.password
  delete obj.mfa?.secretEnc
  delete obj.passwordReset
  return obj
}

export default mongoose.model('User', userSchema)

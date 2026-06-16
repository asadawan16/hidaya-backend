import mongoose from 'mongoose'

const shiftWindowSchema = new mongoose.Schema({
  dayOfWeek: {
    type: Number,
    required: true,
    min: 0,
    max: 6,
  },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  timezone: { type: String, default: 'Asia/Karachi' },
}, { _id: true })

const tutorProfileSchema = new mongoose.Schema({
  tutorId: {
    type: String,
    unique: true,
    required: true,
    trim: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, lowercase: true, trim: true, default: '' },
  skillLevel: {
    type: String,
    enum: ['beginner', 'medium', 'professional', 'expert'],
    default: 'beginner',
  },
  roomNo: { type: String, trim: true, default: '' },
  meetLink: { type: String, trim: true, default: '' },
  shiftWindows: [shiftWindowSchema],
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active',
  },
  salary: {
    baseAmount: { type: Number, default: 0 },
    currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], default: 'PKR' },
  },
  subjects: [{
    type: String,
    enum: ['nazra', 'hifz', 'tafseer', 'tajweed', 'translation', 'qaida'],
  }],
  notes: { type: String, trim: true, default: '' },
}, { timestamps: true })

tutorProfileSchema.index({ status: 1 })
tutorProfileSchema.index({ skillLevel: 1 })

export default mongoose.model('TutorProfile', tutorProfileSchema)

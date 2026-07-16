import mongoose from 'mongoose'

const guardianSchema = new mongoose.Schema({
  relation: {
    type: String,
    enum: ['father', 'mother', 'grandfather', 'grandmother', 'uncle', 'aunty', 'brother', 'sister', 'other'],
    required: true,
  },
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, lowercase: true, trim: true, default: '' },
  isWhatsappRecipient: { type: Boolean, default: false },
}, { _id: true })

const specialNeedSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['patient', 'autism', 'speech', 'learning_difficulty', 'other'],
    required: true,
  },
  note: { type: String, trim: true, default: '' },
}, { _id: true })

const studentSchema = new mongoose.Schema({
  rollNo: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    default: '',
  },
  name: { type: String, required: true, trim: true },
  parentsName: { type: String, trim: true, default: '' },
  dob: { type: Date },
  joiningDate: { type: Date, default: Date.now },
  country: { type: String, trim: true, default: '' },
  timezone: { type: String, trim: true, default: 'Asia/Karachi' },

  guardians: [guardianSchema],
  whatsappNumber: { type: String, trim: true, default: '' },

  courseLabels: [{
    type: String,
    enum: ['nazra', 'hifz', 'tafseer', 'tajweed', 'translation', 'qaida'],
  }],

  placementLevel: {
    type: String,
    enum: ['beginning', 'qaida_basic', 'qaida_weak', 'quran_good', 'quran_weak', 'quran_forgot', ''],
    default: '',
  },

  sect: {
    type: String,
    enum: ['sunni', 'shia', 'ahle_hadith', 'other', ''],
    default: '',
  },

  specialNeeds: [specialNeedSchema],

  familyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Family',
    sparse: true,
  },

  referredBy: { type: String, trim: true, default: '' },

  // The existing student (if any) who referred this student in
  referredByStudent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    sparse: true,
  },

  billing: {
    fee: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP', ''], default: 'PKR' },
    paymentMethod: { type: String, trim: true, default: '' },
    whoPays: {
      type: String,
      enum: ['father', 'mother', 'sponsor', 'self', 'other', ''],
      default: '',
    },
    cycle: { type: String, enum: ['monthly', 'quarterly', 'yearly', ''], default: 'monthly' },
    status: { type: String, enum: ['pending', 'paid', 'overdue', ''], default: 'pending' },
  },

  performanceFlag: { type: String, enum: ['normal', 'weak', 'strong', ''], default: '' },

  // Multi-tag performance/risk markers surfaced with colors on the board
  performanceTags: [{
    type: String,
    enum: ['risky', 'weak', 'strong', 'watch'],
  }],

  // Manual fresh/old marker for board identification
  freshness: { type: String, enum: ['fresh', 'old', ''], default: '' },

  leaveStartDate: { type: Date },
  expectedResumeDate: { type: Date },

  // Two-type staff feedback shown on the student progress page
  feedbacks: [{
    type: { type: String, enum: ['admin', 'quality'], required: true },
    text: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  }],

  status: {
    type: String,
    enum: ['active', 'leave', 'left', 'pending'],
    default: 'pending',
  },

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    sparse: true,
  },

  // Legacy fields kept for backward compat with existing admin
  email: { type: String, lowercase: true, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  adminNotes: [{
    text: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true })

studentSchema.index({ name: 1 })
studentSchema.index({ status: 1 })
studentSchema.index({ 'courseLabels': 1 })
studentSchema.index({ createdAt: -1 })

export default mongoose.model('Student', studentSchema)

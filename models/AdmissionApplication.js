import mongoose from 'mongoose'

const admissionGuardianSchema = new mongoose.Schema({
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

const admissionApplicationSchema = new mongoose.Schema({
  // Student info
  studentName: { type: String, required: true, trim: true },
  parentsName: { type: String, trim: true, default: '' },
  dob: { type: Date },
  country: { type: String, trim: true, default: '' },
  timezone: { type: String, trim: true, default: 'Asia/Karachi' },

  // Guardians
  guardians: [admissionGuardianSchema],
  whatsappNumber: { type: String, trim: true, default: '' },

  // Preferences
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
  specialNeeds: [{
    type: { type: String, enum: ['patient', 'autism', 'speech', 'learning_difficulty', 'other'] },
    note: { type: String, trim: true, default: '' },
  }],

  // Referral
  heardFrom: { type: String, trim: true, default: '' },
  referredBy: { type: String, trim: true, default: '' },

  // Medical / additional
  medicalNotes: { type: String, trim: true, default: '' },
  additionalNotes: { type: String, trim: true, default: '' },

  // Review
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reviewedAt: { type: Date },
  reviewNotes: { type: String, trim: true, default: '' },

  // On approval — admin links
  proposedRelationships: [{
    relatedRollNo: { type: String, trim: true },
    type: { type: String, enum: ['sibling', 'cousin', 'other'] },
  }],

  // Created student reference
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
  },
}, { timestamps: true })

admissionApplicationSchema.index({ status: 1 })
admissionApplicationSchema.index({ createdAt: -1 })

export default mongoose.model('AdmissionApplication', admissionApplicationSchema)

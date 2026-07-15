import mongoose from 'mongoose'

// Demo trial class tracking — mirrors the HQCM Trials/Demo sheet
const demoTrialSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  studentName: { type: String, required: true, trim: true },
  demoTutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile', sparse: true },
  demoTutor: { type: String, trim: true, default: '' }, // denormalized tutor label for display/search
  code: { type: String, trim: true, default: '' },
  source: { type: String, trim: true, default: '' }, // referral channel (Google Ads, Facebook, Instagram, …)
  referredByStudent: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', sparse: true },
  comment: { type: String, trim: true, default: '' },
  status: {
    type: String,
    enum: ['scheduled', 'sign_up', 'failed', 'no_show', 'start_later'],
    default: 'scheduled',
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

demoTrialSchema.index({ status: 1, date: -1 })
demoTrialSchema.index({ studentName: 'text' })

export default mongoose.model('DemoTrial', demoTrialSchema)

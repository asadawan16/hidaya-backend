import mongoose from 'mongoose'

const assessmentSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  templateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AssessmentTemplate',
    required: true,
  },
  date: { type: Date, required: true },
  testTeacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
  },
  regularTeacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
  },
  attendance: {
    type: String,
    enum: ['present', 'absent'],
    default: 'present',
  },
  scope: {
    type: String,
    enum: ['qaida', 'quran', 'qaida_and_quran', 'hifz', 'general'],
    default: 'general',
  },
  responses: [{
    fieldKey: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed },
  }],
  overallScore: { type: Number },
  examinerNotes: { type: String, trim: true, default: '' },
  conductedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true })

assessmentSchema.index({ studentId: 1, date: -1 })
assessmentSchema.index({ date: -1 })

export default mongoose.model('Assessment', assessmentSchema)

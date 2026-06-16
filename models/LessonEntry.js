import mongoose from 'mongoose'

const lessonItemSchema = new mongoose.Schema({
  curriculumItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CurriculumItem',
    required: true,
  },
  fromUnit: { type: String, trim: true, default: '' },
  toUnit: { type: String, trim: true, default: '' },
}, { _id: true })

const lessonEntrySchema = new mongoose.Schema({
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ClassSession',
  },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  tutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
    required: true,
  },
  date: { type: Date, required: true },
  classStart: { type: String, default: '' },
  classEnd: { type: String, default: '' },
  kind: {
    type: String,
    enum: ['daily', 'revision'],
    default: 'daily',
  },
  items: [lessonItemSchema],
  customText: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
}, { timestamps: true })

lessonEntrySchema.index({ studentId: 1, date: -1 })
lessonEntrySchema.index({ tutorId: 1, date: -1 })
lessonEntrySchema.index({ sessionId: 1 })

export default mongoose.model('LessonEntry', lessonEntrySchema)

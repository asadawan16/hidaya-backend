import mongoose from 'mongoose'

const lessonItemSchema = new mongoose.Schema({
  curriculumItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CurriculumItem',
    required: true,
  },
  // Human-readable coverage strings — composed on the client from the structured
  // fields below and kept for backward-compatible display of older entries.
  fromUnit: { type: String, trim: true, default: '' },
  toUnit: { type: String, trim: true, default: '' },
  // Structured coverage (all optional — a single page, a single line, or a single
  // ayah reference is valid; nothing is mandatory). Page is bounded by the item's
  // meta.totalPages (Quran para) or meta.lineCount (Qaida page) on the client.
  fromPage: { type: Number, min: 1 },
  fromLine: { type: Number, min: 1 },
  toPage: { type: Number, min: 1 },
  toLine: { type: Number, min: 1 },
  // Free-text ayah / surah reference, e.g. "Al-Baqarah 1-5" — optional.
  ayah: { type: String, trim: true, default: '' },
  // Hifz portion type for this item: sabaq (new), sabqi (recent revision),
  // manzil (old revision). Empty for non-Hifz or unspecified.
  portion: { type: String, enum: ['', 'new', 'sabqi', 'manzil'], default: '' },
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

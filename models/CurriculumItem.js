import mongoose from 'mongoose'

const curriculumItemSchema = new mongoose.Schema({
  track: {
    type: String,
    enum: ['qaida', 'quran', 'hifz', 'kalima', 'dua', 'namaz', 'islamic_study', 'tafseer'],
    required: true,
  },
  type: {
    type: String,
    enum: ['page', 'line', 'para', 'surah', 'dua', 'component', 'concept', 'section', 'kalima'],
    required: true,
  },
  label: { type: String, required: true, trim: true },
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CurriculumItem',
    default: null,
  },
  order: { type: Number, default: 0 },
  // Expected/min time (in days) a student should take to master this item.
  // Used by the Student Progress view to flag overdue items (cumulative from
  // the student's joining date). 0 = untracked (never flagged).
  expectedDays: { type: Number, default: 0, min: 0 },
  meta: {
    surahNumber: { type: Number },
    paraNumber: { type: Number },
    lineCount: { type: Number },
    arabicLabel: { type: String, trim: true },
    pageNumber: { type: Number },
  },
  active: { type: Boolean, default: true },
}, { timestamps: true })

curriculumItemSchema.index({ track: 1, order: 1 })
curriculumItemSchema.index({ parentId: 1 })
curriculumItemSchema.index({ active: 1 })

export default mongoose.model('CurriculumItem', curriculumItemSchema)

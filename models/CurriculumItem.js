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

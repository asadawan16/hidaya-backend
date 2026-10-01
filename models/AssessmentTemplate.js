import mongoose from 'mongoose'

const fieldSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true },
  label: { type: String, required: true, trim: true },
  type: {
    type: String,
    enum: ['rating', 'scale', 'select', 'text', 'number'],
    required: true,
  },
  options: [String],
  // The % each option is worth, parallel to `options`; null = no % (left out of
  // the average). Unset entries use the standard scale — utils/assessmentScore.js.
  optionScores: { type: [Number], default: undefined },
  required: { type: Boolean, default: false },
}, { _id: true })

const sectionSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true },
  label: { type: String, required: true, trim: true },
  fields: [fieldSchema],
}, { _id: true })

const assessmentTemplateSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  active: { type: Boolean, default: true },
  sections: [sectionSchema],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true })

export default mongoose.model('AssessmentTemplate', assessmentTemplateSchema)

import mongoose from 'mongoose'

const enrollmentSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  message: { type: String, trim: true },
  source: {
    type: String,
    enum: ['hero_form', 'free_class', 'contact', 'enrollment', 'manual'],
    default: 'hero_form',
  },
  status: {
    type: String,
    enum: ['new', 'contacted', 'enrolled', 'closed'],
    default: 'new',
  },
  demoTutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile' },
  trialDate: { type: Date },
  trialStatus: { type: String, enum: ['pending', 'scheduled', 'passed', 'failed', ''], default: '' },
  trialNotes: { type: String, trim: true, default: '' },
}, { timestamps: true })

export default mongoose.model('Enrollment', enrollmentSchema)

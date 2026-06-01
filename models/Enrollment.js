import mongoose from 'mongoose'

const enrollmentSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  message: { type: String, trim: true },
  source: {
    type: String,
    enum: ['hero_form', 'free_class', 'contact', 'enrollment'],
    default: 'hero_form',
  },
  status: {
    type: String,
    enum: ['new', 'contacted', 'enrolled', 'closed'],
    default: 'new',
  },
}, { timestamps: true })

export default mongoose.model('Enrollment', enrollmentSchema)

import mongoose from 'mongoose'

const classSlotSchema = new mongoose.Schema({
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
  // Primary track — kept in sync with tracks[0] for backward compatibility.
  track: {
    type: String,
    enum: ['nazra', 'hifz', 'tafseer', 'tajweed', 'translation', 'qaida'],
    default: 'nazra',
  },
  // A slot can cover multiple tracks (a lesson can be logged against several).
  tracks: [{
    type: String,
    enum: ['nazra', 'hifz', 'tafseer', 'tajweed', 'translation', 'qaida'],
  }],
  dayOfWeek: {
    type: Number,
    required: true,
    min: 0,
    max: 6,
  },
  startTime: { type: String, required: true },
  durationMinutes: { type: Number, default: 30 },
  timezone: { type: String, default: 'Asia/Karachi' },
  meetLink: { type: String, trim: true, default: '' },
  active: { type: Boolean, default: true },
}, { timestamps: true })

classSlotSchema.index({ studentId: 1, active: 1 })
classSlotSchema.index({ tutorId: 1, active: 1 })
classSlotSchema.index({ dayOfWeek: 1, startTime: 1 })

export default mongoose.model('ClassSlot', classSlotSchema)

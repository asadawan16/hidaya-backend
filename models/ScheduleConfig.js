import mongoose from 'mongoose'

// Singleton config (key: 'default') for schedule-wide settings.
const scheduleConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  // When true, a background job generates today's sessions from active slots
  // automatically (Asia/Karachi day). Manual "Generate Sessions" still works either way.
  autoGenerateSessions: { type: Boolean, default: true },
  // Max classes a tutor may take per shift-day, by skill level. Drives the slot
  // board's "spaces available" and slot-creation capacity checks. A tutor with an
  // explicit TutorProfile.capacityOverride ignores these.
  skillCapacity: {
    beginner: { type: Number, default: 14 },
    medium: { type: Number, default: 15 },
    professional: { type: Number, default: 16 },
    expert: { type: Number, default: 16 },
  },
}, { timestamps: true })

export default mongoose.model('ScheduleConfig', scheduleConfigSchema)

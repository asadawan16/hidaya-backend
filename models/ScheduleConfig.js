import mongoose from 'mongoose'

// Singleton config (key: 'default') for schedule-wide settings.
const scheduleConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  // When true, a background job generates today's sessions from active slots
  // automatically (Asia/Karachi day). Manual "Generate Sessions" still works either way.
  autoGenerateSessions: { type: Boolean, default: true },
}, { timestamps: true })

export default mongoose.model('ScheduleConfig', scheduleConfigSchema)

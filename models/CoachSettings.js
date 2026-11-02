import mongoose from 'mongoose'

/*
 * English Coach settings — a singleton (`key: 'default'`), edited on the
 * English Coach page's Settings tab (coach.manage).
 *
 * The AI providers' free plans cap usage per day, so the limits here are what
 * keep one keen tester from spending the whole academy's daily allowance.
 */
const coachSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  enabled: { type: Boolean, default: true },
  // Call lengths a tester may pick, in minutes
  durations: { type: [Number], default: [5, 10] },
  // Tests one person may start in any rolling 24 hours (0 = no limit)
  dailyLimitPerUser: { type: Number, default: 3, min: 0, max: 50 },
  // Tests the whole academy may start in any rolling 24 hours (0 = no limit)
  orgDailyLimit: { type: Number, default: 0, min: 0, max: 1000 },
  // Fewer words than this from the tester and the call is not marked
  minTesterWords: { type: Number, default: 40, min: 10, max: 400 },
  // Scenario keys switched off for testers (config/coachScenarios.js)
  disabledScenarios: { type: [String], default: [] },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

coachSettingsSchema.statics.getSettings = async function getSettings() {
  return this.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
}

export default mongoose.model('CoachSettings', coachSettingsSchema)

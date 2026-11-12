import mongoose from 'mongoose'

/*
 * English Coach settings — a singleton (`key: 'default'`), edited on the
 * English Coach page's Settings tab (coach.manage).
 *
 * The AI providers' free plans cap usage per day, so the limits here are what
 * keep one keen tester from spending the whole academy's daily allowance.
 *
 * `levels` is the ladder on the Levels tab (services/coachProgress.js): Level 1
 * is levels[0]. Each level is one or more tests, each a scenario or script at a
 * difficulty the admin fixes, with the score that passes it. A tester's level
 * is worked out from their level tests (CoachSession.levelItemId), never
 * stored, so editing the ladder re-reads everyone's progress. Item `_id`s are
 * kept across saves — sessions point at them.
 */
const levelItemSchema = new mongoose.Schema({
  scenarioKey: { type: String, required: true },
  difficulty: { type: String, enum: ['very_easy', 'easy', 'normal', 'hard'], required: true },
  // Call length in minutes; absent = the tester chooses from `durations`
  durationMin: { type: Number },
  passScore: { type: Number, min: 0, max: 100, default: 60 },
})

const levelSchema = new mongoose.Schema({
  title: { type: String, trim: true, maxlength: 80, default: '' },
  note: { type: String, trim: true, maxlength: 300, default: '' },
  items: { type: [levelItemSchema], default: [] },
})

const coachSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  enabled: { type: Boolean, default: true },
  // Call lengths a tester may pick, in minutes
  durations: { type: [Number], default: [3, 5, 10] },
  // Tests one person may start in any rolling 24 hours (0 = no limit)
  dailyLimitPerUser: { type: Number, default: 3, min: 0, max: 50 },
  // Tests the whole academy may start in any rolling 24 hours (0 = no limit)
  orgDailyLimit: { type: Number, default: 0, min: 0, max: 1000 },
  // Fewer words than this from the tester and the call is not marked
  minTesterWords: { type: Number, default: 40, min: 10, max: 400 },
  // Scenario keys switched off for testers (config/coachScenarios.js, and the
  // scripted parts' keys — models/CoachScript.js)
  disabledScenarios: { type: [String], default: [] },
  // How scripted parts run for everyone: 'english' = say the book's English
  // line (shown or from memory); 'urdu' = the teacher line is shown in Urdu
  // and the tester says it in English, checked for meaning and grammar
  scriptMode: { type: String, enum: ['english', 'urdu'], default: 'english' },
  // When the Role-Play Practice Book was copied into CoachScript — once, so a
  // part the admin deletes stays deleted
  scriptsSeededAt: { type: Date },
  levels: { type: [levelSchema], default: [] },
  levelsUpdatedAt: { type: Date },
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

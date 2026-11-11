import mongoose from 'mongoose'

/*
 * English Coach — one scripted part (a set of word-for-word role plays),
 * managed on the English Coach page's Scripts tab (coach.manage).
 *
 * The eleven units of Hidaya's Role-Play Practice Book are seeded from
 * config/coachRolePlays.js the first time the coach is used
 * (services/coachScripts.js#ensureBookScripts) and can then be edited like any
 * other part; `builtIn` remembers which unit of the book a part came from, so
 * it can be put back to the book's wording. A part the admin writes has no
 * `builtIn`.
 *
 * A practice call stores a snapshot of the lines it ran
 * (CoachSession.script), so editing or deleting a part never changes a test
 * already taken. `key` is what CoachSettings.disabledScenarios and old
 * sessions refer to — it never changes.
 */
export const SCRIPT_WHO = ['T', 'S', 'P']          // teacher (the tester) · student · parent
export const SCRIPT_STUDENTS = ['S', 'sara']        // config/coachRolePlays.js#BOOK_SPEAKERS
export const SCRIPT_LIMITS = { title: 120, goal: 300, text: 400, urdu: 600, plays: 30, lines: 60 }

const lineSchema = new mongoose.Schema({
  who: { type: String, enum: SCRIPT_WHO, required: true },
  text: { type: String, required: true, trim: true, maxlength: SCRIPT_LIMITS.text },
  // Teacher lines: the Urdu prompt shown in Urdu mode (the tester says it in English)
  urdu: { type: String, trim: true, maxlength: SCRIPT_LIMITS.urdu, default: '' },
}, { _id: false })

const playSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: SCRIPT_LIMITS.title },
  goal: { type: String, trim: true, maxlength: SCRIPT_LIMITS.goal, default: '' },
  // Which student voice says the S lines
  student: { type: String, enum: SCRIPT_STUDENTS, default: 'S' },
  lines: { type: [lineSchema], default: [] },
}, { _id: false })

const coachScriptSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  title: { type: String, required: true, trim: true, maxlength: SCRIPT_LIMITS.title },
  // Position on the Practice tab ("Part 1", "Part 2"…), lowest first
  order: { type: Number, default: 0 },
  plays: { type: [playSchema], default: [] },
  // The book unit this part was seeded from (absent = written in the portal)
  builtIn: { type: Number },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

export default mongoose.model('CoachScript', coachScriptSchema)

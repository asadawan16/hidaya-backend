import mongoose from 'mongoose'

/*
 * One English Coach practice test — a timed, spoken role-play call between a
 * tutor (or staff member) and an AI character, and the scorecard it earned.
 *
 * Lifecycle (`status`):
 *   active    — the call is running. At most ONE per user (partial unique index),
 *               so a second tab or a double-tapped Start can't open two calls.
 *               `busyAt` is the per-call turn lock: a turn claims it atomically,
 *               so two uploads can't interleave the transcript.
 *   scoring   — the call ended with enough of the tester's speech to mark. The
 *               examiner runs in the background; `scoringLockAt` is its claim,
 *               and a claim that goes stale (server restart) is retaken by the
 *               sweeper in portalCoachController#sweepCoachSessions.
 *   scored    — `result` holds the scorecard.
 *   failed    — the examiner failed SCORING_MAX_ATTEMPTS times (AI providers
 *               down or out of free quota). The transcript is kept; the tester
 *               or a reviewer can retry from the scorecard.
 *   too_short — the call ended before the tester said enough to mark fairly.
 *   abandoned — the call ended before the tester said anything.
 *
 * Audio is never stored: each turn's recording is transcribed and dropped. The
 * transcript, the speaking measurements and the scores are what is kept.
 *
 * `scenario` is a snapshot of config/coachScenarios.js at the time of the call,
 * so rewording a scenario never changes how an old test reads.
 */

const turnMetricsSchema = new mongoose.Schema({
  // Per-turn speaking measurements (utils/coachMetrics.js#turnMetrics)
  audioSec: Number,         // length of the recording
  speakingSec: Number,      // first word → last word
  leadingSilenceSec: Number,
  wordCount: Number,        // words, fillers excluded
  fillerCount: Number,
  fillers: [String],
  longPauses: Number,       // gaps between words > LONG_PAUSE_SEC
  longestPauseSec: Number,
  responseDelayMs: Number,  // the character stopped speaking → the tester started recording
  confidence: Number,       // mean Whisper segment avg_logprob (closer to 0 = clearer)
  lowConfidence: Boolean,   // hard to hear — noisy room, mumbling, or not English
  hasTimings: Boolean,      // false when the provider sent no word timings (fluency not measurable)
}, { _id: false })

const turnSchema = new mongoose.Schema({
  role: { type: String, enum: ['persona', 'tester'], required: true },
  text: { type: String, default: '' },
  at: { type: Date, default: Date.now },
  // The browser's id for an uploaded turn — a retried upload of the same turn
  // returns the stored answer instead of adding the turn twice.
  clientTurnId: { type: String },
  metrics: { type: turnMetricsSchema, default: undefined },
  provider: { type: String }, // which model produced a persona line
  // Scripted role-plays: which book voice said a persona line (script.speakers key),
  // and how a tester line compared with the book's (utils/coachScript.js)
  speaker: { type: String },
  check: {
    type: new mongoose.Schema({
      step: Number,      // index into script.steps
      match: Number,     // 0–1, utils/coachScript.js#scriptMatch
      passed: Boolean,
      attempt: Number,   // 1 or 2
    }, { _id: false }),
    default: undefined,
  },
}, { _id: false })

const scoreBlock = {
  fluency: Number,
  grammar: Number,
  vocabulary: Number,
  professionalism: Number,
  clarity: Number,
  handling: Number,
}

const coachSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile' },

  scenarioKey: { type: String, required: true },
  scenario: {
    title: String, summary: String, brief: String,
    personaName: String, personaRole: String, initials: String,
    voice: String, lang: String, gender: String,
    goals: [String],
    // 'tutor' | 'manager' — which house rules the call is marked against
    audience: String,
    group: String,
    // Hidaya's model sentences for this situation (scorecard + examiner)
    academyLines: [String],
    // 'script' = a unit of the Role-Play Practice Book (absent = AI conversation)
    kind: String,
  },
  difficulty: { type: String, enum: ['very_easy', 'easy', 'normal', 'hard'], required: true },

  // A scripted call's snapshot of the book (utils/coachScript.js#buildScript):
  // the role plays it covers, every line in order, and the voices. `scriptPos`
  // is the next line to play or to wait for; `scriptTries` the misses on the
  // teacher line being waited for.
  script: {
    type: new mongoose.Schema({
      unit: Number,
      unitTitle: String,
      startPlay: Number,
      plays: [{ _id: false, n: Number, title: String, goal: String }],
      steps: [{ _id: false, play: Number, who: String, speaker: String, text: String }],
      speakers: mongoose.Schema.Types.Mixed,
      // Words the tester must say for the call to be marked: the Settings
      // minimum, or less when the chosen role plays are short
      minWords: Number,
    }, { _id: false }),
    default: undefined,
  },
  scriptPos: { type: Number },
  scriptTries: { type: Number },
  durationSec: { type: Number, required: true },

  status: {
    type: String,
    enum: ['active', 'scoring', 'scored', 'failed', 'too_short', 'abandoned'],
    default: 'active',
  },
  startedAt: { type: Date, default: Date.now },
  endsAt: { type: Date, required: true },
  endedAt: { type: Date },
  // 'completed' = a scripted call reached the end of its role plays
  endReason: { type: String, enum: ['time_up', 'ended_early', 'expired', 'abandoned', 'completed'] },
  // The tester agreed to their voice and transcript going to the AI providers
  consentAt: { type: Date, required: true },

  turns: { type: [turnSchema], default: [] },
  testerTurns: { type: Number, default: 0 },
  testerWords: { type: Number, default: 0 },
  busyAt: { type: Date, default: null },

  // Whole-call speaking measurements (utils/coachMetrics.js#sessionMetrics)
  metrics: {
    speakingSec: Number,
    wordCount: Number,
    wpm: Number,
    longPauses: Number,
    longPausesPerMin: Number,
    fillerCount: Number,
    fillersPerMin: Number,
    avgResponseSec: Number,
    lexicalDiversity: Number, // MATTR, 0–1
    avgTurnWords: Number,
    lowConfidenceTurns: Number,
  },

  result: {
    overall: Number,
    band: { type: String, enum: ['needs_work', 'developing', 'good', 'excellent'] }, // 85 / 70 / 50 (utils/coachMetrics.js#bandFor)
    scores: scoreBlock,
    reasons: { fluency: String, grammar: String, vocabulary: String, professionalism: String, clarity: String, handling: String },
    cefr: { type: String, enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', null] }, // the examiner's estimate
    fluencyMeasured: Number, // the recording's half of fluency (the examiner's is the other half)
    summary: String,
    strengths: [String],
    improvements: [String],
    corrections: [{
      _id: false,
      original: String, corrected: String, explanation: String,
      type: { type: String, enum: ['grammar', 'vocabulary', 'tone', 'clarity'] },
    }],
    shortSample: Boolean, // marked, but on little speech — the UI says scores are less reliable
    // Scripted calls: how the tester's lines compared with the book's. `score`
    // is the call's "handling" mark (utils/coachScript.js#scriptScore).
    script: {
      total: Number, attempted: Number, firstTime: Number, passed: Number, accuracy: Number, score: Number,
    },
    examiner: String,     // provider/model that marked it
  },
  scoringAttempts: { type: Number, default: 0 },
  scoringLockAt: { type: Date, default: null },
  scoringError: { type: String, default: '' },
  scoredAt: { type: Date },

  // A reviewer's own mark — the human check on the AI's marking (calibration)
  review: {
    score: Number,
    note: String,
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: String,
    at: Date,
  },

  usage: {
    audioSec: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
  },
}, { timestamps: true })

// One live call per person
coachSessionSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_per_user' })
coachSessionSchema.index({ userId: 1, createdAt: -1 })
coachSessionSchema.index({ status: 1, endsAt: 1 })
coachSessionSchema.index({ createdAt: -1 })

export default mongoose.model('CoachSession', coachSessionSchema)

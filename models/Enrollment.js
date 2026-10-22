import mongoose from 'mongoose'

// A short, optional label field from the demo-request form. Values are the
// human labels from the frontend's src/data/demoOptions.js, stored as-is.
const label = (max = 120) => ({ type: String, trim: true, maxlength: max, default: '' })

export const LEAD_STATUSES = ['new', 'contacted', 'callback', 'enrolled', 'closed']

// One entry per call / follow-up a staff member logs against the lead.
const callLogSchema = new mongoose.Schema({
  note: { type: String, required: true, trim: true, maxlength: 2000 },
  outcome: { type: String, trim: true, maxlength: 120, default: '' },
  // The callback this entry scheduled (if any)
  nextCallbackAt: { type: Date },
  // The lead's status after this entry, when the entry changed it
  statusAfter: { type: String, trim: true, default: '' },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: { type: String, trim: true, default: '' },
  at: { type: Date, default: Date.now },
})

const enrollmentSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  message: { type: String, trim: true },
  source: {
    type: String,
    // 'qurantutornow' = the Google Ads landing site (qurantutornow.com), which
    // has no portal of its own and posts its trial form / checkout leads here.
    enum: ['hero_form', 'free_class', 'contact', 'enrollment', 'manual', 'qurantutornow'],
    default: 'hero_form',
  },
  status: {
    type: String,
    // 'callback' = a follow-up call is scheduled (see nextCallbackAt)
    enum: LEAD_STATUSES,
    default: 'new',
  },
  // How this lead found us (social media platform / channel), free-form label
  referralSource: { type: String, trim: true, default: '' },
  // The existing student (if any) who referred this lead in
  referredByStudent: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', sparse: true },
  demoTutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile' },
  trialDate: { type: Date },
  trialStatus: { type: String, enum: ['pending', 'scheduled', 'passed', 'failed', ''], default: '' },
  trialNotes: { type: String, trim: true, default: '' },

  // ── Structured demo request (public free-demo form) ──
  program: { type: String, enum: ['academic', 'quran', 'both', ''], default: '' },
  // Academic
  subject: label(),
  grade: label(),
  curriculum: label(),
  // Quran
  quranCourse: label(),
  quranLevel: label(),
  ageGroup: label(),
  // Both
  preferredTime: label(),
  tutorPreference: label(),
  studentCount: label(),

  // ── Call tracking ──
  nextCallbackAt: { type: Date, index: true },
  callLog: { type: [callLogSchema], default: [] },
}, { timestamps: true })

export default mongoose.model('Enrollment', enrollmentSchema)

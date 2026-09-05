import mongoose from 'mongoose'

// A meeting link published on the PUBLIC class-links page (/class-links) that is
// shared with students in groups. Deliberately a separate collection from
// TutorProfile.meetLink: a tutor can publish several links (per batch/course),
// each with its own publish toggle, and toggling one off here never touches the
// link the portal/schedule uses internally.
const classLinkSchema = new mongoose.Schema({
  tutor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
    required: true,
  },
  // Snapshot of the tutor's name at publish time — the public endpoint never
  // needs the tutor document to render a card, and a renamed/removed tutor
  // can't blank out a live card mid-shift.
  tutorName: { type: String, required: true, trim: true },
  url: { type: String, required: true, trim: true },

  // Everything below is OPTIONAL — a card renders from tutorName + url alone,
  // and only shows the extras that were actually filled in.
  label: { type: String, trim: true, default: '' },
  platform: {
    type: String,
    enum: ['zoom', 'google_meet', 'teams', 'skype', 'whatsapp', 'other'],
    default: 'other',
  },
  // Free-text timing override (e.g. "Mon–Fri · 9:00 PM – 11:00 PM PKT"). Blank
  // → the public endpoint falls back to the tutor's shiftWindows.
  timing: { type: String, trim: true, default: '' },
  note: { type: String, trim: true, default: '' },

  // Card visual theme index into the public page's THEMES array. null → auto
  // (assigned by position so every card still looks distinct).
  theme: { type: Number, default: null, min: 0, max: 7 },

  isActive: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

classLinkSchema.index({ isActive: 1, order: 1 })
classLinkSchema.index({ tutor: 1 })

export default mongoose.model('ClassLink', classLinkSchema)

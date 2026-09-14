import mongoose from 'mongoose'
import crypto from 'crypto'

/**
 * A meeting link published for ONE student, reachable on its own private page
 * (/my-class/:token) instead of the shared board at /class-links.
 *
 * Deliberately a separate collection from ClassLink: that one is a grid of
 * tutor cards everyone sees, this one is a single card addressed to a named
 * student. Keeping them apart means the public board query stays
 * `find({ isActive: true })` with no "…and not a student link" clause, and a
 * student page can never accidentally list somebody else's class.
 *
 * The page is addressed by a random `token`, not by the student's _id. An
 * ObjectId encodes a timestamp and a counter, so a parent who has one URL can
 * guess neighbouring ones; a random token can't be walked.
 */

// 12 url-safe chars — enough entropy that the space can't be swept, short
// enough to paste into WhatsApp without wrapping.
export function newLinkToken() {
  return crypto.randomBytes(9).toString('base64url')
}

const studentClassLinkSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
    unique: true,
  },
  // Snapshot at publish time — the public page renders the greeting without
  // needing the student document, and a deleted student can't blank the card.
  studentName: { type: String, required: true, trim: true },
  rollNo: { type: String, trim: true, default: '' },

  token: { type: String, required: true, unique: true, default: newLinkToken },

  url: { type: String, required: true, trim: true },

  // Everything below is OPTIONAL — the page renders from name + url alone and
  // only shows the extras that were actually filled in.
  label: { type: String, trim: true, default: '' },
  tutorName: { type: String, trim: true, default: '' },
  platform: {
    type: String,
    enum: ['zoom', 'google_meet', 'teams', 'skype', 'whatsapp', 'other'],
    default: 'other',
  },
  timing: { type: String, trim: true, default: '' },
  note: { type: String, trim: true, default: '' },

  // Index into the public page's THEMES array. null → derived from the token
  // so a student's page keeps the same colour on every visit.
  theme: { type: Number, default: null, min: 0, max: 7 },

  isActive: { type: Boolean, default: true },
  clicks: { type: Number, default: 0 },
  lastClickedAt: { type: Date },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

studentClassLinkSchema.index({ isActive: 1 })

export default mongoose.model('StudentClassLink', studentClassLinkSchema)

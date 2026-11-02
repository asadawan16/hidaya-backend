import mongoose from 'mongoose'

/*
 * One WhatsApp class reminder — a tutor tapped "Send reminder" on a class.
 *
 * Once per class: `dedupeKey` (student + PKT day + start time) is unique, so
 * the same class can never be reminded twice — not from two tabs at once, and
 * not after its session is deleted and regenerated with a new _id.
 *
 * Lifecycle:
 *   sending — claimed, the Meta call is in flight. If the server dies here the
 *             row goes stale; a claim older than CLAIM_STALE_MS is taken over
 *             by the next tap instead of blocking the class forever.
 *   sent    — Meta accepted it and returned a wamid. Delivery (sent →
 *             delivered → read, or failed) lives on the WhatsappMessage row with
 *             that wamid, updated by the webhook.
 * A Meta rejection (bad template, expired token, number not allowed…) DELETES
 * the claim, so the tutor can try again once it is fixed — only a message that
 * actually left counts as the one reminder.
 *
 * The recipient's number is kept for staff (WhatsApp page) and never returned
 * to the tutor.
 */
const classReminderSchema = new mongoose.Schema({
  // Unique too: a daylight-saving move changes the start time (and so the
  // dedupeKey) of a class that has already been reminded.
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSession', required: true, unique: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true, index: true },
  tutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile', required: true },
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // `${studentId}:${YYYY-MM-DD}:${HH:MM}` — the class, independent of the session _id
  dedupeKey: { type: String, required: true, unique: true },
  // Absolute class start, for sorting the log
  classStartAt: { type: Date, required: true },

  status: { type: String, enum: ['sending', 'sent'], default: 'sending' },
  claimedAt: { type: Date, default: Date.now },
  sentAt: { type: Date },

  // Who it went to — 'guardian' | 'student'; the guardian's relation for display
  recipientType: { type: String, enum: ['guardian', 'student'], required: true },
  recipientLabel: { type: String, default: '' },
  waId: { type: String, required: true },

  templateName: { type: String, default: '' },
  wamid: { type: String, default: '' },
}, { timestamps: true })

classReminderSchema.index({ classStartAt: -1 })
classReminderSchema.index({ wamid: 1 })

export default mongoose.model('ClassReminder', classReminderSchema)

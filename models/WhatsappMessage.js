import mongoose from 'mongoose'

/*
 * One WhatsApp Cloud API message, either direction.
 *
 *   in   — a student/guardian wrote to the academy number. Arrives on the
 *          webhook (value.messages[]). status stays 'received'.
 *   out  — the portal sent it (template reminder or a chat reply). Its status
 *          walks sent → delivered → read (or failed) as value.statuses[]
 *          arrive on the webhook, matched on wamid.
 *
 * `wamid` is Meta's message id and is unique, so a redelivered webhook can
 * never insert the same message twice.
 *
 * The 24-hour customer-service window is derived, not stored: it is open while
 * the newest `in` message for a waId is less than 24h old.
 */
const whatsappMessageSchema = new mongoose.Schema({
  wamid: { type: String, required: true, unique: true },
  direction: { type: String, enum: ['in', 'out'], required: true },

  // The other party's WhatsApp id — international digits, no '+' (e.g. 923001234567)
  waId: { type: String, required: true, index: true },
  contactName: { type: String, default: '' },
  // Which of our business numbers it went through
  phoneNumberId: { type: String, default: '' },

  // text | image | audio | video | document | sticker | location | contacts |
  // interactive | button | reaction | template | unsupported …
  type: { type: String, default: 'text' },
  // Human-readable body — the text, a caption, a button title, a reaction emoji
  text: { type: String, default: '' },
  // Media is NOT downloaded here — Meta media ids expire, the portal fetches on demand
  media: {
    id: String,
    mimeType: String,
    filename: String,
  },
  // wamid of the message this one replies to / reacts to
  contextWamid: { type: String, default: '' },
  // Outbound template name, when it was a template
  templateName: { type: String, default: '' },

  status: {
    type: String,
    enum: ['received', 'accepted', 'sent', 'delivered', 'read', 'failed'],
    default: 'received',
  },
  statusAt: { type: Date },
  statusErrors: [{ code: Number, title: String, details: String, _id: false }],

  // When WhatsApp says it happened (not when we stored it)
  timestamp: { type: Date, required: true },

  // Matched on phone at ingest; null for unknown numbers (leads, wrong numbers)
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null, index: true },
  // Portal user who sent an outbound message
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  readByStaffAt: { type: Date, default: null },
}, { timestamps: true })

// Conversation view + 24h-window lookup: newest messages per contact
whatsappMessageSchema.index({ waId: 1, timestamp: -1 })

export default mongoose.model('WhatsappMessage', whatsappMessageSchema)

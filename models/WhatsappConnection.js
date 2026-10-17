import mongoose from 'mongoose'

/*
 * Singleton (key: 'default') — the academy's WhatsApp Business number as
 * connected through Meta's Embedded Signup on /portal/whatsapp.
 *
 * `coexistence` means the number stays live in the WhatsApp Business app on
 * the office phone AND is on the Cloud API. Messages typed on the phone come
 * back as `smb_message_echoes` webhooks; the phone's past chats arrive once as
 * `history` webhooks after we request a sync (Meta allows that request only in
 * the first 24 hours after onboarding).
 *
 * `accessTokenEnc` is the business-integration token from the code exchange,
 * AES-GCM encrypted with MFA_ENCRYPTION_KEY (utils/totp.js). It is never sent
 * to the browser and this model is excluded from the portal data export.
 */
const syncSchema = new mongoose.Schema({
  requestedAt: Date,
  error: { type: String, default: '' },
}, { _id: false })

const whatsappConnectionSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  status: { type: String, enum: ['connected', 'disconnected'], default: 'disconnected' },

  wabaId: { type: String, default: '' },
  businessId: { type: String, default: '' },
  phoneNumberId: { type: String, default: '' },
  displayPhoneNumber: { type: String, default: '' },
  verifiedName: { type: String, default: '' },
  qualityRating: { type: String, default: '' },
  coexistence: { type: Boolean, default: false },

  accessTokenEnc: { type: String, default: '', select: false },
  subscribedAt: Date,

  contactsSync: { type: syncSchema, default: () => ({}) },
  historySync: { type: syncSchema, default: () => ({}) },
  // 0–100, from the `history` webhook's chunk metadata; null until the first chunk
  historyProgress: { type: Number, default: null },
  // Set when the phone owner declined to share chat history (Meta error 2593109)
  historyDeclined: { type: Boolean, default: false },

  connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  connectedAt: Date,
  disconnectedAt: Date,
}, { timestamps: true })

export default mongoose.model('WhatsappConnection', whatsappConnectionSchema)

import mongoose from 'mongoose'

/*
 * The academy's WhatsApp contact book — the names numbers are saved under, so
 * WhatsApp Chats shows "Ahmed's mum (USA)" rather than whatever profile name
 * the contact gave WhatsApp. One row per number, keyed on its last 10 digits
 * (utils/whatsappContacts.js#phoneKey), so "+92 300 1234567", "0300-1234567"
 * and the waId "923001234567" are the same contact.
 *
 * A name can come from three places; the first one set wins (nameOf):
 *   customName  typed in the portal (WhatsApp Chats → the chat's ⋯ → Edit name)
 *   phoneName   saved on the office phone, sent by Meta's `smb_app_state_sync`
 *               webhook (coexistence numbers only)
 *   importName  from an uploaded contacts file (.vcf / .csv)
 *
 * WhatsappChat.savedName is a copy of the winner, kept in step by
 * utils/whatsappContacts.js#refreshChatNames.
 */
const whatsappContactSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  // The fullest form of the number seen so far (digits only, may lack the country code)
  digits: { type: String, default: '' },
  customName: { type: String, default: '', trim: true },
  phoneName: { type: String, default: '', trim: true },
  importName: { type: String, default: '', trim: true },
  customBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  phoneSyncedAt: { type: Date, default: null },
  importedAt: { type: Date, default: null },
}, { timestamps: true })

export default mongoose.model('WhatsappContact', whatsappContactSchema)

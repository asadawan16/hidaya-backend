import mongoose from 'mongoose'

/*
 * One row per WhatsApp contact — the chat list on /portal/whatsapp-chats.
 *
 * DERIVED from WhatsappMessage: utils/whatsappChats.js#syncChat recomputes a
 * row from the messages whenever one is stored, sent or read, and
 * rebuildWhatsappChats() regenerates the whole collection (it runs by itself
 * the first time the chat list is opened on a database that has messages but
 * no chats yet). Nothing here is the source of truth, so it is left out of the
 * data export.
 */
const whatsappChatSchema = new mongoose.Schema({
  // The contact's WhatsApp id — international digits, no '+'. Never sent to
  // staff who only hold whatsapp.chat; they address a chat by its _id.
  waId: { type: String, required: true, unique: true },
  // WhatsApp profile name from the newest inbound message that carried one
  contactName: { type: String, default: '' },
  // The name the number is saved under in the academy's contact book
  // (models/WhatsappContact.js — typed in the portal, synced from the office
  // phone, or from an uploaded contacts file) and where it came from:
  // 'portal' | 'phone' | 'import'. Copied here so the list can show and search it.
  savedName: { type: String, default: '' },
  nameSource: { type: String, default: '' },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null, index: true },

  lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsappMessage', default: null },
  lastMessageAt: { type: Date, default: null },
  // Newest message FROM the contact — the 24-hour customer-service window runs from here
  lastInboundAt: { type: Date, default: null },
  // Inbound messages nobody on the team has read (history replays excluded)
  unreadCount: { type: Number, default: 0 },

  // Archived: out of the main list, under "Archived". Shared by the whole team,
  // and undone by itself when the contact writes again (utils/whatsappChats.js).
  archivedAt: { type: Date, default: null },
  archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Removed from the portal: messages up to this moment are no longer shown
  // anywhere in the portal (they stay in the database, on the phone and on
  // WhatsApp). The row is kept — it is what remembers the cut-off — and the
  // chat comes back, empty of the old messages, when a new one arrives.
  clearedAt: { type: Date, default: null },
  clearedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

whatsappChatSchema.index({ lastMessageAt: -1 })

export default mongoose.model('WhatsappChat', whatsappChatSchema)

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
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null, index: true },

  lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsappMessage', default: null },
  lastMessageAt: { type: Date, default: null },
  // Newest message FROM the contact — the 24-hour customer-service window runs from here
  lastInboundAt: { type: Date, default: null },
  // Inbound messages nobody on the team has read (history replays excluded)
  unreadCount: { type: Number, default: 0 },
}, { timestamps: true })

whatsappChatSchema.index({ lastMessageAt: -1 })

export default mongoose.model('WhatsappChat', whatsappChatSchema)

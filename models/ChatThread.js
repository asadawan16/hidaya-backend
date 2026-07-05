import mongoose from 'mongoose'

const chatThreadSchema = new mongoose.Schema({
  // Channel or DM
  type: {
    type: String,
    enum: ['channel', 'dm'],
    default: 'dm',
  },
  // Channel-specific fields
  name: { type: String, trim: true, default: '' },
  description: { type: String, trim: true, default: '' },
  label: {
    type: String,
    enum: ['general', 'announcement', 'class', 'support', 'staff', 'custom', ''],
    default: '',
  },
  labelColor: { type: String, trim: true, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Participants
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  }],

  // Channel member roles (channels only). Creator is owner.
  memberRoles: [{
    _id: false,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['owner', 'admin', 'member'], default: 'member' },
  }],

  // Per-user conversation preferences (pin/favourite/mute/label/background)
  userPrefs: [{
    _id: false,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    pinned: { type: Boolean, default: false },
    favourite: { type: Boolean, default: false },
    mutedUntil: { type: Date, default: null }, // null = unmuted; year 9999 = forever
    label: { type: String, trim: true, default: '' },
    labelColor: { type: String, trim: true, default: '' },
    background: { type: String, trim: true, default: '' },
  }],

  // Last message info (denormalized for list performance)
  lastMessageAt: { type: Date, default: Date.now },
  lastMessagePreview: { type: String, trim: true, default: '' },
  lastMessageSenderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Pinned messages
  pinnedMessages: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
  }],

  // Archive
  archived: { type: Boolean, default: false },
}, { timestamps: true })

chatThreadSchema.index({ participants: 1 })
chatThreadSchema.index({ type: 1, lastMessageAt: -1 })
chatThreadSchema.index({ name: 'text' })

export default mongoose.model('ChatThread', chatThreadSchema)

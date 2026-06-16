import mongoose from 'mongoose'

const attachmentSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  url: { type: String, trim: true },
  type: { type: String, trim: true },
  size: { type: Number, default: 0 },
  mimeType: { type: String, trim: true, default: '' },
}, { _id: true })

const mentionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  displayName: { type: String, trim: true, default: '' },
}, { _id: false })

const messageSchema = new mongoose.Schema({
  threadId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatThread',
    required: true,
  },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  // Content
  body: { type: String, required: true, trim: true },
  bodyHtml: { type: String, trim: true, default: '' },
  format: {
    type: String,
    enum: ['plain', 'markdown', 'rich'],
    default: 'plain',
  },

  // Attachments (files, images)
  attachments: [attachmentSchema],

  // Mentions (@user)
  mentions: [mentionSchema],

  // Threading
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
    default: null,
  },
  replyCount: { type: Number, default: 0 },

  // Starred by users
  starredBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],

  // Pinned
  pinned: { type: Boolean, default: false },
  pinnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  pinnedAt: { type: Date },

  // Read tracking
  readBy: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    readAt: { type: Date },
  }],

  // Edit / delete
  edited: { type: Boolean, default: false },
  editedAt: { type: Date },
  deleted: { type: Boolean, default: false },
}, { timestamps: true })

messageSchema.index({ threadId: 1, createdAt: -1 })
messageSchema.index({ threadId: 1, parentId: 1 })
messageSchema.index({ 'mentions.userId': 1 })
messageSchema.index({ starredBy: 1 })
messageSchema.index({ body: 'text' })

export default mongoose.model('Message', messageSchema)

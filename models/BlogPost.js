import mongoose from 'mongoose'

const blogPostSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  title: { type: String, required: true, trim: true },
  excerpt: { type: String, default: '', trim: true },
  content: [{
    heading: { type: String, trim: true },
    text: { type: String, trim: true },
  }],
  author: { type: String, default: 'Hidaya Online', trim: true },
  coverImageKey: { type: String, default: '' },
  published: { type: Boolean, default: true },
  publishedAt: { type: Date, default: () => new Date() },
}, { timestamps: true })

blogPostSchema.index({ published: 1, publishedAt: -1 })

export default mongoose.model('BlogPost', blogPostSchema)

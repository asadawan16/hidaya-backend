import mongoose from 'mongoose'

// Singleton config for the public /class-links page (headline copy, the optional
// access code, and the master publish switch). Always read through
// ClassLinkSettings.getSettings() — it creates the single document on first use.
const classLinkSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  headline: { type: String, trim: true, default: 'Live Class Links' },
  subheadline: {
    type: String,
    trim: true,
    default: 'Find your teacher below and tap Join to enter the class.',
  },
  // Blank → the page is open to anyone with the URL. Set → visitors must enter
  // this code once before the links are revealed.
  accessCode: { type: String, trim: true, default: '' },
  // Master switch — off takes the whole page down without deleting any link.
  isPublished: { type: Boolean, default: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

classLinkSettingsSchema.statics.getSettings = async function () {
  let doc = await this.findOne({ key: 'default' })
  if (!doc) doc = await this.create({ key: 'default' })
  return doc
}

export default mongoose.model('ClassLinkSettings', classLinkSettingsSchema)

import mongoose from 'mongoose'

const familySchema = new mongoose.Schema({
  familyCode: {
    type: String,
    unique: true,
    required: true,
    trim: true,
    uppercase: true,
  },
  primaryGuardian: {
    name: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, lowercase: true, trim: true, default: '' },
    relation: { type: String, trim: true, default: '' },
  },
  members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
  }],
  notes: { type: String, trim: true, default: '' },
}, { timestamps: true })

// familyCode already indexed via unique: true

export default mongoose.model('Family', familySchema)

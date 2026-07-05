import mongoose from 'mongoose'

const staffProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  title: { type: String, trim: true, default: '' },
  department: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
}, { timestamps: true })

// userId already indexed via unique: true

export default mongoose.model('StaffProfile', staffProfileSchema)

import mongoose from 'mongoose'

const tutorAttendanceSchema = new mongoose.Schema({
  tutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
    required: true,
  },
  date: { type: Date, required: true },
  checkInAt: { type: Date },
  checkOutAt: { type: Date },
  totalHours: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['present', 'absent', 'partial'],
    default: 'absent',
  },
  notes: { type: String, trim: true, default: '' },
  isOvertime: { type: Boolean, default: false },
  overtimeReason: { type: String, enum: ['extra_classes', 'late_checkout', 'approved_overtime', ''], default: '' },
}, { timestamps: true })

tutorAttendanceSchema.index({ tutorId: 1, date: -1 })
tutorAttendanceSchema.index({ date: 1 })

export default mongoose.model('TutorAttendance', tutorAttendanceSchema)

import mongoose from 'mongoose'

const permanentLessonSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
  },
  tutorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TutorProfile',
    required: true,
  },
  curriculumItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CurriculumItem',
    required: true,
  },
  completedDate: { type: Date, default: Date.now },
  status: {
    type: String,
    enum: ['pending_approval', 'approved', 'rejected'],
    default: 'pending_approval',
  },
  video: {
    received: { type: Boolean, default: false },
    receivedAt: { type: Date },
    storageRef: { type: String, trim: true, default: '' },
    externalUrl: { type: String, trim: true, default: '' },
    status: {
      type: String,
      enum: ['pending', 'uploaded', 'reviewed', ''],
      default: '',
    },
  },
  submittedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedAt: { type: Date },
  rejectionReason: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
}, { timestamps: true })

permanentLessonSchema.index({ studentId: 1, status: 1 })
permanentLessonSchema.index({ tutorId: 1, status: 1 })
permanentLessonSchema.index({ status: 1 })
permanentLessonSchema.index({ curriculumItemId: 1 })

export default mongoose.model('PermanentLesson', permanentLessonSchema)

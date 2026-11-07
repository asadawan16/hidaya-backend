import mongoose from 'mongoose'

// A saved set of Tasks-page filters ("Overdue, all tutors"), one click to
// bring back. Private to its owner unless shared with everyone.
const taskViewSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  filters: { type: mongoose.Schema.Types.Mixed, default: {} },
  shared: { type: Boolean, default: false },
}, { timestamps: true })

taskViewSchema.index({ userId: 1 })
taskViewSchema.index({ shared: 1 })

export default mongoose.model('TaskView', taskViewSchema)

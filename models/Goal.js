import mongoose from 'mongoose'

// A weekly or monthly goal ("Enrol 5 new students this month"). Progress is
// the share of its linked tasks that are done, or done ÷ target when a target
// count is set.
const goalSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 2000, default: '' },
  period: { type: String, enum: ['weekly', 'monthly'], default: 'weekly' },
  // First and last day of the week/month the goal covers (date-only, UTC midnight)
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  target: { type: Number, min: 0, default: 0 }, // 0 = all linked tasks
  owners: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, enum: ['active', 'achieved', 'missed', 'archived'], default: 'active' },
  color: { type: String, trim: true, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

goalSchema.index({ startDate: -1 })
goalSchema.index({ owners: 1 })

export default mongoose.model('Goal', goalSchema)

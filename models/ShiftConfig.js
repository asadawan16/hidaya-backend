import mongoose from 'mongoose'

const shiftConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  defaultShiftStart: { type: String, default: '09:00' },
  defaultShiftEnd: { type: String, default: '17:00' },
  overtimeThresholdMinutes: { type: Number, default: 0 },
  bonusRules: {
    fullAttendanceBonus: { type: Number, default: 0 },
    onTimeBonus: { type: Number, default: 0 },
    extraHoursRate: { type: Number, default: 0 },
    extraClassBonus: { type: Number, default: 0 },
  },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

export default mongoose.model('ShiftConfig', shiftConfigSchema)

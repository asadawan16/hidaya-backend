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
  // Payroll: monthly base salary for this staff member (used as the default when
  // generating their salary record; editable per-month on the salary sheet).
  baseSalary: { type: Number, default: 0 },
  salaryCurrency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP', 'CAD'], default: 'PKR' },
}, { timestamps: true })

// userId already indexed via unique: true

export default mongoose.model('StaffProfile', staffProfileSchema)

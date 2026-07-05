import mongoose from 'mongoose'

const expenseSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  type: { type: String, enum: ['expense', 'income'], default: 'expense' },
  category: {
    type: String,
    enum: ['office_supplies', 'utilities', 'rent', 'equipment', 'software', 'travel', 'marketing', 'maintenance', 'miscellaneous', 'petty_cash', 'budget'],
    required: true,
  },
  amount: { type: Number, required: true },
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], default: 'PKR' },
  date: { type: Date, required: true },
  description: { type: String, trim: true, default: '' },
  receiptUrl: { type: String, trim: true, default: '' },
  recurring: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

expenseSchema.index({ date: -1 })
expenseSchema.index({ category: 1 })

export default mongoose.model('Expense', expenseSchema)

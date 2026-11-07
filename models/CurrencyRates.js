import mongoose from 'mongoose'

// Singleton (`key: 'default'`): how many rupees one unit of each currency is
// worth. Entered by an admin on the Revenue page; every PKR figure on the
// Revenue page and the fee dashboards is converted with these.
const currencyRatesSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  rates: {
    USD: { type: Number, min: 0, default: 278 },
    EUR: { type: Number, min: 0, default: 312 },
    GBP: { type: Number, min: 0, default: 355 },
    CAD: { type: Number, min: 0, default: 205 },
  },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedByName: { type: String, trim: true, default: '' },
}, { timestamps: true })

export default mongoose.model('CurrencyRates', currencyRatesSchema)

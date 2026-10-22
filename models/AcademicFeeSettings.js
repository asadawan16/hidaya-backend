import mongoose from 'mongoose'

/*
 * What the public Fee page shows about academic tutoring fees, edited in the
 * portal (Plans → Academic fees). A singleton (`key: 'default'`), like
 * PaymentSettings.
 *
 * Prices are per 60-minute class; the site multiplies by classes a week × 4
 * for the monthly figure. With `showPrices` off the public endpoint never
 * sends a price, so a half-filled table can sit here safely until he is ready.
 */

export const FEE_CURRENCIES = ['USD', 'GBP', 'EUR']

// The starting point when nothing has been saved yet. Mirrored by the
// frontend's static fallback in src/data/fees.js (used for the prerender).
export const DEFAULT_ACADEMIC_FEES = {
  showPrices: false,
  minutes: 60,
  schedules: [2, 3, 5],
  footnote: 'Fees depend on the grade and the number of classes a week. We confirm the exact fee with you after the free demo.',
  bands: [
    { key: 'primary', title: 'Primary & Elementary', range: 'Grades 1–5', recommended: 2, note: '', perClass: {} },
    { key: 'middle', title: 'Middle School', range: 'Grades 6–8', recommended: 3, note: '', perClass: {} },
    { key: 'secondary', title: 'High School, GCSE & IGCSE', range: 'Grades 9–12', recommended: 3, note: '', perClass: {} },
    { key: 'advanced', title: 'University & test prep', range: 'University · SAT · GRE · GMAT', recommended: 3, note: '', perClass: {} },
  ],
}

const priceMap = Object.fromEntries(FEE_CURRENCIES.map((c) => [c, { type: Number, min: 0 }]))

const bandSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true, maxlength: 40 },
  title: { type: String, required: true, trim: true, maxlength: 60 },
  range: { type: String, trim: true, maxlength: 60, default: '' },
  recommended: { type: Number, min: 1, max: 7 },
  note: { type: String, trim: true, maxlength: 200, default: '' },
  perClass: priceMap,
}, { _id: false })

const academicFeeSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  showPrices: { type: Boolean, default: false },
  minutes: { type: Number, min: 15, max: 180, default: 60 },
  schedules: { type: [Number], default: [2, 3, 5] },
  footnote: { type: String, trim: true, maxlength: 300, default: '' },
  bands: { type: [bandSchema], default: [] },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

export default mongoose.model('AcademicFeeSettings', academicFeeSettingsSchema)

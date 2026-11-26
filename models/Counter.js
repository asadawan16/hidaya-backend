import mongoose from 'mongoose'

// A number that only goes up, one per `key` (e.g. 'fee-tracker-receipt-2026').
// Used where a printed number must never be handed out twice, even after the
// record that carried it is deleted.
const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, trim: true },
  seq: { type: Number, default: 0 },
}, { timestamps: true })

export default mongoose.models.Counter || mongoose.model('Counter', counterSchema)

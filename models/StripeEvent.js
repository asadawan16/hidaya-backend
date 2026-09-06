import mongoose from 'mongoose'

/*
 * Webhook idempotency ledger.
 *
 * Stripe guarantees AT-LEAST-once delivery: the same event can arrive twice
 * (retry after a timeout, or a duplicate from the dashboard). Inserting the
 * event id first — with a unique index — means a redelivery fails the insert
 * and we skip the handler instead of recording a second payment.
 *
 * Rows expire after 30 days; Stripe stops retrying long before that.
 */
const stripeEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  // 'processing' → 'done' | 'error'. A row stuck on 'processing' means the
  // handler crashed mid-flight; the stored error makes that visible.
  status: { type: String, enum: ['processing', 'done', 'error'], default: 'processing' },
  error: { type: String, default: '' },
}, { timestamps: true })

stripeEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 })

export default mongoose.model('StripeEvent', stripeEventSchema)

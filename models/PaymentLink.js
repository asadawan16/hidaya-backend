import mongoose from 'mongoose'
import crypto from 'crypto'

const paymentLinkSchema = new mongoose.Schema({
  // Payee info
  payeeName: { type: String, required: true, trim: true },
  payeeEmail: { type: String, lowercase: true, trim: true, default: '' },
  payeePhone: { type: String, trim: true },

  // Payment details
  description: { type: String, required: true, trim: true },
  amount: { type: Number, required: true },
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP', 'CAD'], default: 'PKR' },

  // Optional tax added on top of the amount (applied to the post-discount subtotal)
  taxType: { type: String, enum: ['none', 'percentage', 'fixed'], default: 'none' },
  taxValue: { type: Number, default: 0 }, // percentage points (3/5/6/10/custom) or a fixed amount

  // Which gateway the payer is sent to. Chosen when the link is created.
  gateway: { type: String, enum: ['mastercard', 'stripe'], default: 'mastercard' },

  // one_time  — a single charge (either gateway)
  // recurring — a Stripe subscription; Stripe stores the mandate and charges
  //             every cycle. Mastercard hosted checkout has no subscription
  //             support here, so recurring implies gateway === 'stripe'.
  paymentMode: { type: String, enum: ['one_time', 'recurring'], default: 'one_time' },

  recurring: {
    interval: { type: String, enum: ['day', 'week', 'month', 'year'], default: 'month' },
    intervalCount: { type: Number, default: 1, min: 1 }, // e.g. month × 3 = quarterly
    trialDays: { type: Number, default: 0, min: 0 },
  },

  // Stripe subscription state (recurring links only) — set by the webhook.
  stripeCustomerId: { type: String, default: '' },
  stripeSubscriptionId: { type: String, default: '' },
  // Mirrors Stripe's subscription.status (trialing/active/past_due/canceled/…)
  subscriptionStatus: { type: String, default: '' },
  subscriptionCurrentPeriodEnd: { type: Date },
  subscriptionCancelAtPeriodEnd: { type: Boolean, default: false },

  // Unique token for the link
  token: {
    type: String,
    unique: true,
    default: () => crypto.randomBytes(24).toString('hex'),
  },

  // Status — only expires on successful payment
  status: {
    type: String,
    enum: ['active', 'completed', 'failed'],
    default: 'active',
  },

  // Invoice number — auto-generated, updated on each payment for recurring links
  invoiceNo: { type: String, trim: true, default: '' },

  // Linked payment (most recent — created when user clicks Pay Now)
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },

  // All payments made on this link (for recurring/reusable links)
  payments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }],

  // Line items shown on the payment page
  items: [{ type: String, trim: true }],
  listType: { type: String, enum: ['bullet', 'numbered'], default: 'bullet' },

  // Optional linked student (single)
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },

  // Optional linked family + specific members the payment covers
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family' },
  studentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],

  // Which funnel minted this link. '' = created by staff in the portal/admin;
  // 'qurantutornow' = self-serve checkout from the ad landing site.
  source: { type: String, trim: true, default: '' },

  // Admin notes
  notes: { type: String, trim: true },

  // Whether the link expires (becomes unusable) after successful payment
  expiresAfterPayment: { type: Boolean, default: true },

  // Whether email was sent
  emailSent: { type: Boolean, default: false },
}, { timestamps: true })

paymentLinkSchema.index({ token: 1 })
paymentLinkSchema.index({ status: 1 })
paymentLinkSchema.index({ createdAt: -1 })
paymentLinkSchema.index({ payeeEmail: 1 })
paymentLinkSchema.index({ student: 1 })
paymentLinkSchema.index({ familyId: 1 })
paymentLinkSchema.index({ stripeSubscriptionId: 1 })

export default mongoose.model('PaymentLink', paymentLinkSchema)

// Smoke test for the fee-page gateway toggle + the Stripe plan-checkout path.
//
// Covers:
//   - the PaymentSettings singleton: default, update, validation, and the
//     degrade-to-mastercard rule when Stripe isn't configured
//   - the public GET /api/payments/settings shape the fee page reads
//   - POST /api/payments/initiate-stripe: 503 without a key, field validation,
//     discount-code validation, and the Payment row it writes
//   - finalizePlanPayment idempotency — the webhook and the browser return URL
//     both settle the same payment and must not double-count a discount code
//   - settlePlanPaymentFromSession against a mocked Stripe session
//
// Creates temp payments/discount codes and cleans them up. Requires MONGODB_URI
// only — no Stripe key, no running server. A real STRIPE_SECRET_KEY in .env is
// respected (the Stripe-disabled assertions are skipped).
// Run: node scripts/smoke-fee-gateway.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import Payment from '../models/Payment.js'
import PaymentSettings from '../models/PaymentSettings.js'
import DiscountCode from '../models/DiscountCode.js'
import { isStripeEnabled } from '../services/stripe.js'
import {
  getSettingsDoc, resolveFeeGateway, publicSettings, getSettings, updateSettings,
} from '../controllers/paymentSettingsController.js'
import {
  initiateStripe, finalizePlanPayment, settlePlanPaymentFromSession,
} from '../controllers/paymentController.js'

let pass = 0, fail = 0, skipped = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }
const skip = (m) => { skipped++; console.log('  ○', m, '(skipped)') }

function mockRes() {
  const res = { _status: 200, _json: null }
  res.status = (c) => { res._status = c; return res }
  res.json = (d) => { res._json = d; return res }
  return res
}
const req = (body = {}) => ({ body, method: 'POST', path: '/smoke' })

const createdPayments = []
const createdCodes = []
let originalGateway = null

const STRIPE_ON = isStripeEnabled()

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
  console.log(`Connected. Stripe key present: ${STRIPE_ON ? 'yes' : 'no'}\n[1] PaymentSettings singleton`)

  const settings = await getSettingsDoc()
  originalGateway = settings.feeGateway
  ok(['mastercard', 'stripe'].includes(settings.feeGateway), `settings row exists (feeGateway=${settings.feeGateway})`)

  const second = await getSettingsDoc()
  ok(String(second._id) === String(settings._id), 'getSettingsDoc is a singleton — no second row is created')
  ok(await PaymentSettings.countDocuments({ key: 'default' }) === 1, 'exactly one row with key=default')

  console.log('\n[2] updateSettings validation')
  const bad = mockRes()
  await updateSettings({ ...req({ feeGateway: 'paypal' }) }, bad)
  ok(bad._status === 400, 'an unknown gateway is rejected with 400')

  const missing = mockRes()
  await updateSettings({ ...req({}) }, missing)
  ok(missing._status === 400, 'a missing gateway is rejected with 400')

  const toMc = mockRes()
  await updateSettings({ ...req({ feeGateway: 'mastercard' }) }, toMc)
  ok(toMc._status === 200 && toMc._json?.feeGateway === 'mastercard', 'switching to mastercard succeeds')
  ok(await resolveFeeGateway() === 'mastercard', 'resolveFeeGateway reports mastercard')

  const toStripe = mockRes()
  await updateSettings({ ...req({ feeGateway: 'stripe' }) }, toStripe)
  if (STRIPE_ON) {
    ok(toStripe._status === 200 && toStripe._json?.feeGateway === 'stripe', 'switching to stripe succeeds when configured')
    ok(await resolveFeeGateway() === 'stripe', 'resolveFeeGateway reports stripe')
  } else {
    ok(toStripe._status === 400, 'switching to stripe is refused when STRIPE_SECRET_KEY is absent')
    ok((await getSettingsDoc()).feeGateway === 'mastercard', 'the stored setting is left untouched by the refusal')
  }

  console.log('\n[3] the shapes the fee page and the admin page read')
  const pub = mockRes()
  await publicSettings({}, pub)
  ok(['mastercard', 'stripe'].includes(pub._json?.feeGateway), 'public settings returns a feeGateway')
  ok(pub._json?.stripeConfigured === undefined, 'public settings does NOT leak server config state')

  const adminView = mockRes()
  await getSettings({}, adminView)
  ok(typeof adminView._json?.stripeConfigured === 'boolean', 'admin settings reports stripeConfigured')
  ok(adminView._json?.stripeConfigured === STRIPE_ON, 'stripeConfigured matches the environment')

  // The degrade rule: a stored 'stripe' on a server with no key must never be
  // handed to the fee page, or the Pay button can only ever 503.
  console.log('\n[4] a stripe setting degrades to mastercard when Stripe is not configured')
  if (STRIPE_ON) {
    skip('needs a server with no STRIPE_SECRET_KEY')
  } else {
    await PaymentSettings.updateOne({ key: 'default' }, { feeGateway: 'stripe' })
    ok(await resolveFeeGateway() === 'mastercard', 'resolveFeeGateway degrades a stranded stripe setting')
    const degraded = mockRes()
    await publicSettings({}, degraded)
    ok(degraded._json?.feeGateway === 'mastercard', 'the fee page is told mastercard')
    const stored = mockRes()
    await getSettings({}, stored)
    ok(stored._json?.feeGateway === 'stripe', 'the admin page still sees what is actually stored')
    await PaymentSettings.updateOne({ key: 'default' }, { feeGateway: 'mastercard' })
  }

  console.log('\n[5] POST /api/payments/initiate-stripe')
  const base = {
    studentName: 'SMOKE Fee Payer', studentEmail: 'smoke-fee@example.com',
    plan: '3 Days / Week', amount: 14000, currency: 'PKR',
  }

  if (!STRIPE_ON) {
    const off = mockRes()
    await initiateStripe(req(base), off)
    ok(off._status === 503, 'returns 503 when Stripe is not configured')
  } else {
    skip('the 503 path needs a server with no STRIPE_SECRET_KEY')
  }

  const noFields = mockRes()
  await initiateStripe(req({ studentName: 'X' }), noFields)
  ok(noFields._status === (STRIPE_ON ? 400 : 503), 'incomplete bodies never reach Stripe')

  // Discount validation must behave identically to the Mastercard path — it is
  // the same pricePlanCharge() helper, so a bad code fails before any charge.
  const code = await DiscountCode.create({
    code: `SMOKEFEE${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
    discountAmount: 2000, currency: 'USD', usageType: 'one_time', isActive: true,
  })
  createdCodes.push(code._id)

  if (STRIPE_ON) {
    const wrongCur = mockRes()
    await initiateStripe(req({ ...base, discountCode: code.code }), wrongCur)
    ok(wrongCur._status === 400, 'a USD code on a PKR charge is rejected before checkout')
  } else {
    skip('discount rejection through the live Stripe path')
  }

  console.log('\n[6] finalizePlanPayment idempotency')
  const payment = await Payment.create({
    studentName: 'SMOKE Fee Payer', studentEmail: 'smoke-fee@example.com',
    plan: '3 Days / Week', amount: 12000, currency: 'PKR',
    gatewayOrderId: `SMOKE-FEE-${Date.now()}`, gateway: 'stripe', paymentMethod: 'STRIPE',
    status: 'pending', quantity: 1,
    discountCode: code.code, discountCodeRef: code._id, discountAmount: 2000, originalAmount: 14000,
  })
  createdPayments.push(payment._id)

  payment.status = 'completed'
  await finalizePlanPayment({ payment, alreadySettled: false, source: 'smoke' })
  let used = (await DiscountCode.findById(code._id)).timesUsed
  ok(used === 1, 'a completed plan payment burns the discount code once')

  // The webhook and the browser return URL both settle this payment.
  await finalizePlanPayment({ payment, alreadySettled: true, source: 'smoke-replay' })
  used = (await DiscountCode.findById(code._id)).timesUsed
  ok(used === 1, 'a replayed settle does NOT burn the code a second time')

  console.log('\n[7] settlePlanPaymentFromSession')
  const pending = await Payment.create({
    studentName: 'SMOKE Session Payer', studentEmail: 'smoke-session@example.com',
    plan: '2 Days / Week', amount: 10000, currency: 'PKR',
    gatewayOrderId: `SMOKE-SESS-${Date.now()}`, gateway: 'stripe', paymentMethod: 'STRIPE',
    status: 'pending', quantity: 1, stripeSessionId: `cs_smoke_${Date.now()}`,
  })
  createdPayments.push(pending._id)

  const sessionFor = (over = {}) => ({
    id: pending.stripeSessionId,
    metadata: { kind: 'plan', paymentId: String(pending._id) },
    payment_status: 'paid',
    status: 'complete',
    payment_intent: `pi_smoke_${Date.now()}`,
    ...over,
  })

  // Still open — the payer bounced off the Stripe page without paying.
  const stillOpen = await settlePlanPaymentFromSession(sessionFor({ payment_status: 'unpaid', status: 'open' }), { source: 'smoke' })
  ok(stillOpen?.status === 'pending', 'an unpaid, still-open session leaves the payment pending')

  const settled = await settlePlanPaymentFromSession(sessionFor(), { source: 'smoke' })
  ok(settled?.status === 'completed', 'a paid session completes the payment')
  ok(settled?.gateway === 'stripe' && settled?.paymentMethod === 'STRIPE', 'the Stripe gateway/method are stamped on it')
  ok(!!settled?.stripePaymentIntentId, 'the payment intent id is recorded')
  ok(settled?.gatewayTransactionId === settled?.stripePaymentIntentId, 'gatewayTransactionId mirrors the intent id')

  const replayed = await settlePlanPaymentFromSession(sessionFor(), { source: 'smoke-replay' })
  ok(replayed?.status === 'completed', 'replaying the same session is a safe no-op')

  const unknown = await settlePlanPaymentFromSession({ id: 'cs_does_not_exist', metadata: {}, payment_status: 'paid' }, { source: 'smoke' })
  ok(unknown === null, 'a session with no payment behind it returns null rather than throwing')

  console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed, ${skipped} skipped`)
}

run()
  .catch(err => { console.error('FATAL', err); fail++ })
  .finally(async () => {
    if (originalGateway) await PaymentSettings.updateOne({ key: 'default' }, { feeGateway: originalGateway })
    if (createdPayments.length) await Payment.deleteMany({ _id: { $in: createdPayments } })
    if (createdCodes.length) await DiscountCode.deleteMany({ _id: { $in: createdCodes } })
    console.log(`\nCleaned up ${createdPayments.length} payment(s), ${createdCodes.length} code(s); feeGateway restored to ${originalGateway}.`)
    await mongoose.disconnect()
    process.exit(fail === 0 ? 0 : 1)
  })

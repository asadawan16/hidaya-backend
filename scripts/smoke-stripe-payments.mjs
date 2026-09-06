// Smoke test for the Stripe gateway + recurring payment links.
//
// Covers the logic that runs with no Stripe account attached:
//   - normalizeGatewayFields validation (recurring is Stripe-only, caps, expiry)
//   - createPaymentLink persists gateway/paymentMode/recurring
//   - getByToken echoes them to the public pay page
//   - toMinorUnits currency conversion (the 100× bug class)
//   - settleLinkPayment idempotency — the webhook and the browser return URL
//     both settle the same payment and must not double-count
//   - recurring links never flip to 'completed' and roll a fresh invoice number
//     per cycle
//
// Creates temp links/payments and cleans them up. Requires MONGODB_URI only —
// no Stripe key, no running server.
// Run: node scripts/smoke-stripe-payments.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import PaymentLink from '../models/PaymentLink.js'
import Payment from '../models/Payment.js'
import '../models/Student.js'
import '../models/Family.js'
import '../models/DiscountCode.js'
import { createPaymentLink } from '../controllers/portalPaymentController.js'
import { getByToken } from '../controllers/paymentLinkController.js'
import { normalizeGatewayFields, describeInterval } from '../utils/paymentLinkOptions.js'
import { toMinorUnits, fromMinorUnits } from '../services/stripe.js'
import { settleLinkPayment, priceLinkCharge, buildPaymentData } from '../services/paymentLinkFulfillment.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }
function mockRes() {
  const res = { _status: 200, _json: null }
  res.status = (c) => { res._status = c; return res }
  res.json = (d) => { res._json = d; return res }
  return res
}
const req = (body = {}, query = {}, params = {}) => ({ userId: new mongoose.Types.ObjectId(), body, query, params })

const createdLinks = []
const createdPayments = []

async function makeLink(extra) {
  const res = mockRes()
  await createPaymentLink(req({ payeeName: 'SMOKE Stripe', description: 'Smoke stripe link', amount: 10000, currency: 'PKR', ...extra }), res)
  if (res._json?._id) createdLinks.push(res._json._id)
  return res
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
  console.log('Connected.\n[1] normalizeGatewayFields validation')

  ok(normalizeGatewayFields({}).values.gateway === 'mastercard', 'defaults to the mastercard gateway')
  ok(normalizeGatewayFields({}).values.paymentMode === 'one_time', 'defaults to one_time billing')
  ok(normalizeGatewayFields({ gateway: 'paypal' }).values.gateway === 'mastercard', 'unknown gateway falls back to mastercard')
  ok(!!normalizeGatewayFields({ paymentMode: 'recurring', gateway: 'mastercard' }).error, 'recurring + mastercard is rejected')
  ok(!normalizeGatewayFields({ paymentMode: 'recurring', gateway: 'stripe' }).error, 'recurring + stripe is accepted')
  ok(normalizeGatewayFields({ paymentMode: 'recurring', gateway: 'stripe' }).values.expiresAfterPayment === false,
    'recurring forces expiresAfterPayment=false')
  ok(!!normalizeGatewayFields({ paymentMode: 'recurring', gateway: 'stripe', recurring: { interval: 'month', intervalCount: 13 } }).error,
    'interval count above the Stripe cap is rejected (month × 13)')
  ok(normalizeGatewayFields({ paymentMode: 'recurring', gateway: 'stripe', recurring: { interval: 'nonsense' } }).values.recurring.interval === 'month',
    'unknown interval falls back to month')
  ok(describeInterval({ interval: 'month', intervalCount: 1 }) === 'monthly', 'describeInterval: monthly')
  ok(describeInterval({ interval: 'month', intervalCount: 3 }) === 'every 3 months', 'describeInterval: every 3 months')

  console.log('\n[2] toMinorUnits currency conversion')
  ok(toMinorUnits(10000, 'PKR') === 1000000, 'PKR 10,000 → 1,000,000 paisa')
  ok(toMinorUnits(49.99, 'USD') === 4999, 'USD 49.99 → 4999 cents')
  ok(toMinorUnits(5000, 'JPY') === 5000, 'JPY is zero-decimal — not multiplied')
  ok(fromMinorUnits(4999, 'USD') === 49.99, 'round-trips back to 49.99')

  console.log('\n[3] createPaymentLink persists the gateway/recurring fields')
  const oneOff = await makeLink({ gateway: 'stripe' })
  ok(oneOff._json?.gateway === 'stripe', 'stripe one-off link stores gateway=stripe')
  ok(oneOff._json?.paymentMode === 'one_time', 'stripe one-off link stores paymentMode=one_time')

  const badRecurring = await makeLink({ gateway: 'mastercard', paymentMode: 'recurring' })
  ok(badRecurring._status === 400, 'API rejects recurring on mastercard with 400')

  const recurring = await makeLink({
    gateway: 'stripe', paymentMode: 'recurring',
    recurring: { interval: 'month', intervalCount: 3, trialDays: 7 },
    expiresAfterPayment: true, // deliberately wrong — must be overridden
  })
  ok(recurring._json?.paymentMode === 'recurring', 'recurring link stores paymentMode=recurring')
  ok(recurring._json?.recurring?.intervalCount === 3, 'stores intervalCount=3')
  ok(recurring._json?.recurring?.trialDays === 7, 'stores trialDays=7')
  ok(recurring._json?.expiresAfterPayment === false, 'client-supplied expiresAfterPayment=true is overridden to false')

  console.log('\n[4] getByToken exposes the fields to the pay page')
  const pubRes = mockRes()
  await getByToken({ params: { token: recurring._json.token } }, pubRes)
  ok(pubRes._json?.gateway === 'stripe', 'pay page sees gateway=stripe')
  ok(pubRes._json?.paymentMode === 'recurring', 'pay page sees paymentMode=recurring')
  ok(pubRes._json?.recurring?.interval === 'month', 'pay page sees the interval')
  ok(pubRes._json?.recurring?.trialDays === 7, 'pay page sees the trial length')

  const pubOneOff = mockRes()
  await getByToken({ params: { token: oneOff._json.token } }, pubOneOff)
  ok(pubOneOff._json?.recurring === null, 'one-off link reports recurring=null')

  console.log('\n[5] settleLinkPayment — one-off link')
  const singleLink = await PaymentLink.findById((await makeLink({ gateway: 'stripe' }))._json._id)
  const pricing = await priceLinkCharge(singleLink, '')
  ok(pricing.finalAmount === 10000, 'prices a 10,000 link with no discount/tax at 10,000')

  const p1 = await Payment.create(buildPaymentData(singleLink, {
    orderId: `SMOKE-${Date.now()}`, finalAmount: pricing.finalAmount, taxAmount: 0,
    appliedDiscount: null, gateway: 'stripe', paymentMethod: 'STRIPE',
  }))
  createdPayments.push(p1._id)
  p1.status = 'completed'
  await settleLinkPayment({ link: singleLink, payment: p1, source: 'smoke' })
  ok(singleLink.status === 'completed', 'expiring one-off link flips to completed')
  ok(singleLink.payments.length === 1, 'payment recorded once on the link')

  // Re-entry: the webhook and the return URL both settle the same payment.
  await settleLinkPayment({ link: singleLink, payment: p1, alreadySettled: true, source: 'smoke-replay' })
  ok(singleLink.payments.length === 1, 'a replayed settle does NOT double-record the payment')

  console.log('\n[6] settleLinkPayment — recurring link across two cycles')
  const subLink = await PaymentLink.findById(recurring._json._id)
  const invoiceCycle1 = subLink.invoiceNo

  const c1 = await Payment.create(buildPaymentData(subLink, {
    orderId: `SMOKE-SUB1-${Date.now()}`, finalAmount: 10000, taxAmount: 0,
    appliedDiscount: null, gateway: 'stripe', paymentMethod: 'STRIPE',
  }))
  createdPayments.push(c1._id)
  c1.status = 'completed'
  c1.billingReason = 'subscription_create'
  c1.stripeInvoiceId = `in_smoke_${Date.now()}_1`
  await settleLinkPayment({ link: subLink, payment: c1, source: 'smoke' })

  ok(subLink.status !== 'completed', 'recurring link stays open after the first cycle')
  ok(subLink.invoiceNo !== invoiceCycle1, 'a fresh invoice number is rolled for the next cycle')
  ok(c1.invoiceNo === invoiceCycle1, 'cycle 1 keeps the invoice number it was charged under')

  const invoiceCycle2 = subLink.invoiceNo
  const c2 = await Payment.create(buildPaymentData(subLink, {
    orderId: `SMOKE-SUB2-${Date.now()}`, finalAmount: 10000, taxAmount: 0,
    appliedDiscount: null, gateway: 'stripe', paymentMethod: 'STRIPE',
  }))
  createdPayments.push(c2._id)
  c2.status = 'completed'
  c2.billingReason = 'subscription_cycle'
  c2.stripeInvoiceId = `in_smoke_${Date.now()}_2`
  await settleLinkPayment({ link: subLink, payment: c2, source: 'smoke' })

  ok(subLink.payments.length === 2, 'both cycles are recorded against the link')
  ok(c2.invoiceNo === invoiceCycle2, 'cycle 2 carries its own invoice number')
  ok(subLink.status !== 'completed', 'recurring link still open after the second cycle')

  console.log('\n[7] duplicate Stripe invoice is rejected by the unique index')
  await Payment.syncIndexes().catch(() => {})
  let dupBlocked = false
  try {
    const dup = await Payment.create(buildPaymentData(subLink, {
      orderId: `SMOKE-DUP-${Date.now()}`, finalAmount: 10000, taxAmount: 0,
      appliedDiscount: null, gateway: 'stripe', paymentMethod: 'STRIPE',
    }))
    createdPayments.push(dup._id)
    dup.stripeInvoiceId = c2.stripeInvoiceId
    await dup.save()
  } catch (err) {
    dupBlocked = err?.code === 11000
  }
  ok(dupBlocked, 'a second Payment for the same stripeInvoiceId is refused (no double-charge row)')

  console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`)
}

run()
  .catch(err => { console.error('FATAL', err); fail++ })
  .finally(async () => {
    if (createdPayments.length) await Payment.deleteMany({ _id: { $in: createdPayments } })
    if (createdLinks.length) await PaymentLink.deleteMany({ _id: { $in: createdLinks } })
    console.log(`\nCleaned up ${createdLinks.length} link(s), ${createdPayments.length} payment(s).`)
    await mongoose.disconnect()
    process.exit(fail === 0 ? 0 : 1)
  })

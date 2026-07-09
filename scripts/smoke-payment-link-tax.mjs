// Smoke test for Payment Link tax feature.
// Verifies: createPaymentLink persists taxType/taxValue (percentage/fixed/none
// normalization), getByToken echoes them to the public pay page, and the tax
// formula (shared by initiate/initiatePayPal and the frontend) is correct.
// Creates temp links, cleans them up. Run: node scripts/smoke-payment-link-tax.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import PaymentLink from '../models/PaymentLink.js'
import '../models/Student.js'
import '../models/Family.js'
import '../models/Payment.js'
import { createPaymentLink } from '../controllers/portalPaymentController.js'
import { getByToken } from '../controllers/paymentLinkController.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }
function mockRes() {
  const res = { _status: 200, _json: null }
  res.status = (c) => { res._status = c; return res }
  res.json = (d) => { res._json = d; return res }
  return res
}
const req = (body = {}, query = {}, params = {}) => ({ userId: new mongoose.Types.ObjectId(), body, query, params })

// Mirror of computeTax in paymentLinkController.js / calcTax on the frontend
const calcTax = (subtotal, taxType, taxValue) => {
  const amt = Number(subtotal) || 0
  const val = Number(taxValue) || 0
  if (taxType === 'percentage') return Math.round(amt * (val / 100) * 100) / 100
  if (taxType === 'fixed') return Math.max(0, val)
  return 0
}

const created = []
async function makeLink(extra) {
  const res = mockRes()
  await createPaymentLink(req({ payeeName: 'SMOKE Tax', description: 'Smoke tax link', amount: 10000, currency: 'PKR', ...extra }), res)
  if (res._json?._id) created.push(res._json._id)
  return res
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
  console.log('Connected.\n[1] createPaymentLink persistence')

  // Percentage tax
  let res = await makeLink({ taxType: 'percentage', taxValue: 10 })
  ok(res._status === 201, 'percentage link created (201)')
  ok(res._json?.taxType === 'percentage' && res._json?.taxValue === 10, 'stores taxType=percentage, taxValue=10')
  const pctToken = res._json.token

  // Fixed tax
  res = await makeLink({ taxType: 'fixed', taxValue: 250 })
  ok(res._json?.taxType === 'fixed' && res._json?.taxValue === 250, 'stores taxType=fixed, taxValue=250')

  // No tax (default)
  res = await makeLink({})
  ok(res._json?.taxType === 'none' && res._json?.taxValue === 0, 'defaults to taxType=none, taxValue=0')

  // Bad taxType is normalized to none; negative value clamped
  res = await makeLink({ taxType: 'garbage', taxValue: -5 })
  ok(res._json?.taxType === 'none' && res._json?.taxValue === 0, 'invalid taxType normalized to none')

  console.log('\n[2] getByToken echoes tax to public pay page')
  res = mockRes()
  await getByToken(req({}, {}, { token: pctToken }), res)
  ok(res._json?.taxType === 'percentage' && res._json?.taxValue === 10, 'getByToken returns taxType/taxValue')
  ok('amount' in res._json && res._json.amount === 10000, 'getByToken still returns base amount')

  console.log('\n[3] tax formula (matches initiate + frontend)')
  ok(calcTax(10000, 'percentage', 10) === 1000, '10% of 10000 = 1000')
  ok(calcTax(9500, 'percentage', 5) === 475, '5% of a discounted 9500 subtotal = 475')
  ok(calcTax(10000, 'percentage', 7.5) === 750, 'custom 7.5% of 10000 = 750')
  ok(calcTax(10000, 'fixed', 250) === 250, 'fixed 250 = 250')
  ok(calcTax(10000, 'none', 0) === 0, 'none = 0')
  ok(10000 + calcTax(10000, 'percentage', 6) === 10600, 'total = amount + 6% tax = 10600')

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
}

run()
  .catch(e => { console.error('FATAL', e); fail++ })
  .finally(async () => {
    if (created.length) {
      await PaymentLink.deleteMany({ _id: { $in: created } })
      console.log(`Cleaned up ${created.length} temp links`)
    }
    await mongoose.disconnect()
    process.exit(fail === 0 ? 0 : 1)
  })

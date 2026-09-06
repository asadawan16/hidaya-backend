// Smoke test for the satellite-site endpoints: the qurantutornow.com price
// book, its self-serve Stripe checkout, and its free-trial form.
//
// Runs against a RUNNING dev server (npm run dev), because the two things most
// worth proving here are HTTP-level and invisible from inside the process:
//   - CORS actually lets qurantutornow.com through and actually blocks others
//   - the checkout prices from the server's book and ignores any `amount` the
//     browser sends, so nobody can POST their way to a one-dollar enrolment
//
// Set STRIPE_SECRET_KEY (any non-empty value works — the checkout endpoint
// only mints a payment link, it never calls Stripe) or the checkout tests will
// correctly report 503 and be skipped.
//
// Cleans up every record it creates.
// Run: node scripts/smoke-public-checkout.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import PaymentLink from '../models/PaymentLink.js'
import Enrollment from '../models/Enrollment.js'

const BASE = `http://localhost:${process.env.PORT || 5000}/api`
const CHANNEL = 'qurantutornow'
const MARK = 'smoke-public@example.com'
const MARK2 = 'smoke-public-trial@example.com'

let pass = 0, fail = 0
const ok = (c, m, extra = '') => {
  if (c) { pass++; console.log('  ✓', m) }
  else { fail++; console.error('  ✗', m, extra ? `— ${extra}` : '') }
}

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* no body */ }
  return { status: res.status, data, headers: res.headers }
}

async function run() {
  // Fail fast with a useful message rather than a wall of fetch errors.
  try {
    const health = await fetch(`${BASE}/health`)
    if (!health.ok) throw new Error(`health ${health.status}`)
  } catch {
    console.error(`\n✗ No server on ${BASE}. Start it first:  npm run dev\n`)
    process.exit(1)
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })

  console.log('[1] Price book')
  const offers = await call('GET', `/public/offers/${CHANNEL}`)
  ok(offers.status === 200, 'GET /public/offers/qurantutornow returns 200', `got ${offers.status}`)
  ok(offers.data?.plans?.length === 3, 'three plans in the book')
  ok(offers.data?.currencies?.length === 4, 'four currencies offered')
  const threeDay = offers.data?.plans?.find(p => p.id === '3-days')
  ok(threeDay?.prices?.USD === 55, 'the ad channel keeps its own USD 55 rate (not the main site\'s)')
  ok(typeof offers.data?.stripeReady === 'boolean', 'reports whether Stripe is live')

  const unknown = await call('GET', '/public/offers/does-not-exist')
  ok(unknown.status === 404, 'unknown channel 404s')

  console.log('\n[2] CORS allow-list')
  for (const origin of ['https://qurantutornow.com', 'https://www.qurantutornow.com', 'https://hidaya.online']) {
    const r = await call('GET', `/public/offers/${CHANNEL}`, null, { Origin: origin })
    ok(r.headers.get('access-control-allow-origin') === origin, `${origin} is allowed`)
  }
  const blocked = await call('GET', `/public/offers/${CHANNEL}`, null, { Origin: 'https://evil.example.com' })
  ok(!blocked.headers.get('access-control-allow-origin'), 'an unlisted origin gets no CORS header')

  const preflight = await fetch(`${BASE}/public/checkout`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://qurantutornow.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  })
  ok(preflight.status < 300, 'POST preflight from qurantutornow.com succeeds', `got ${preflight.status}`)
  ok(preflight.headers.get('access-control-allow-origin') === 'https://qurantutornow.com', 'preflight echoes the origin')

  console.log('\n[3] Checkout')
  if (!offers.data?.stripeReady) {
    const off = await call('POST', '/public/checkout', { channel: CHANNEL, planId: '3-days', currency: 'USD', name: 'X', email: MARK })
    ok(off.status === 503, 'with no STRIPE_SECRET_KEY the checkout refuses cleanly (503)')
    console.log('  … set STRIPE_SECRET_KEY to exercise the rest of section 3')
  } else {
    // The whole point: the browser sends a plan, never a price.
    const spoof = await call('POST', '/public/checkout', {
      channel: CHANNEL, planId: '3-days', currency: 'USD', billing: 'one_time',
      name: 'Smoke Public', email: MARK, phone: '+10000000000',
      amount: 1, price: 1, // ← ignored
    })
    ok(spoof.status === 201, 'one-time checkout returns 201', `got ${spoof.status}`)
    ok(spoof.data?.amount === 55, 'a spoofed amount is ignored — server prices it at USD 55', `got ${spoof.data?.amount}`)
    ok(spoof.data?.recurring === false, 'one-time checkout is not recurring')
    ok(/\/pay\/[a-f0-9]{32,}$/.test(spoof.data?.payUrl || ''), 'returns a /pay/:token URL to redirect to')
    ok(!spoof.data?.payUrl?.includes('qurantutornow'), 'the pay URL points at the Hidaya site, not the ad site')

    const monthly = await call('POST', '/public/checkout', {
      channel: CHANNEL, planId: '2-days', currency: 'PKR', billing: 'monthly',
      name: 'Smoke Public', email: MARK,
    })
    ok(monthly.status === 201 && monthly.data?.recurring === true, 'monthly checkout starts a recurring link')
    ok(monthly.data?.amount === 10000, 'priced at the channel\'s PKR 10,000 rate')

    const badCur = await call('POST', '/public/checkout', { channel: CHANNEL, planId: '3-days', currency: 'CAD', name: 'X', email: MARK })
    ok(badCur.status === 400, 'a currency the channel does not publish is rejected')

    const badPlan = await call('POST', '/public/checkout', { channel: CHANNEL, planId: '9-days', currency: 'USD', name: 'X', email: MARK })
    ok(badPlan.status === 400, 'an unknown plan is rejected')

    const noName = await call('POST', '/public/checkout', { channel: CHANNEL, planId: '3-days', currency: 'USD', email: MARK })
    ok(noName.status === 400, 'name and email are required')

    // Stored shape
    const links = await PaymentLink.find({ payeeEmail: MARK }).lean()
    ok(links.length === 2, 'both checkouts persisted a payment link')
    ok(links.every(l => l.gateway === 'stripe'), 'every self-serve link is a Stripe link')
    ok(links.every(l => l.source === CHANNEL), 'links are tagged with the originating channel')
    const rec = links.find(l => l.paymentMode === 'recurring')
    ok(rec?.expiresAfterPayment === false, 'the recurring link stays open for future cycles')

    // One lead, not one per attempt.
    const leads = await Enrollment.find({ email: MARK }).lean()
    ok(leads.length === 1, 'repeated checkout attempts collapse into ONE lead', `got ${leads.length}`)
    ok(leads[0]?.source === CHANNEL, 'the lead is tagged qurantutornow')
  }

  console.log('\n[4] Free-trial form')
  const trial = await call('POST', '/public/trial', {
    channel: CHANNEL, name: 'Smoke Trial', email: MARK2,
    phone: '+10000000001', preferredTime: 'Evenings EST', course: 'Tajweed',
  })
  ok(trial.status === 201, 'POST /public/trial returns 201', `got ${trial.status}`)

  const lead = await Enrollment.findOne({ email: MARK2 }).lean()
  ok(!!lead, 'the enquiry landed as an Enrollment (the portal Leads board)')
  ok(lead?.source === CHANNEL, 'tagged qurantutornow so the ad funnel is separable')
  ok(lead?.message?.includes('Tajweed') && lead?.message?.includes('Evenings EST'), 'course and preferred time are carried into the lead')
  ok(lead?.referralSource === 'Google Ads', 'referral source defaults to Google Ads')

  const noEmail = await call('POST', '/public/trial', { channel: CHANNEL, name: 'X' })
  ok(noEmail.status === 400, 'a trial request without an email is rejected')

  console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`)
}

run()
  .catch(err => { console.error('FATAL', err); fail++ })
  .finally(async () => {
    if (mongoose.connection.readyState === 1) {
      const l = await PaymentLink.deleteMany({ payeeEmail: { $in: [MARK, MARK2] } })
      const e = await Enrollment.deleteMany({ email: { $in: [MARK, MARK2] } })
      console.log(`\nCleaned up ${l.deletedCount} link(s), ${e.deletedCount} lead(s).`)
      await mongoose.disconnect()
    }
    process.exit(fail === 0 ? 0 : 1)
  })

// Smoke test for the fee-based Revenue dashboard endpoint.
// Connects to Mongo, calls getRevenueStats with mocked req/res for the current
// month, whole-year, and each source filter, and asserts the response shape.
// Run: node scripts/smoke-revenue.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import { getRevenueStats } from '../controllers/portalDashboardController.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }

function mockRes() {
  const res = { _status: 200, _json: null }
  res.status = (c) => { res._status = c; return res }
  res.json = (d) => { res._json = d; return res }
  return res
}
const req = (query = {}) => ({ query })

async function run(query, label) {
  const res = mockRes()
  await getRevenueStats(req(query), res)
  console.log(`\n[${label}] ${JSON.stringify(query)}`)
  ok(res._status === 200, 'responds 200')
  const d = res._json || {}
  ok(d && !d.error, `no error (${d.error || 'ok'})`)
  ok(d.period && typeof d.period.year === 'number', `period.label = ${d.period?.label}`)
  ok(Array.isArray(d.receivedByCurrency) && d.receivedByCurrency.length === 5, 'receivedByCurrency has 5 currencies')
  ok(d.receivedByCurrency?.some(c => c.currency === 'CAD'), 'CAD present in receivedByCurrency')
  ok(typeof d.totalReceivedPKR === 'number', `totalReceivedPKR = ${d.totalReceivedPKR}`)
  ok(typeof d.totalFeePKR === 'number', `totalFeePKR = ${d.totalFeePKR} (${d.studentCount} students, avg ${d.avgFeePerStudentPKR})`)
  ok(typeof d.totalExpensePKR === 'number', `totalExpensePKR = ${d.totalExpensePKR} (salaries ${d.salaryPKR})`)
  ok(d.netProfitPKR === d.totalReceivedPKR - d.totalExpensePKR, 'netProfit = received - expense')
  ok(!('paymentConversionRate' in d), 'conversion rate removed')
  ok(Array.isArray(d.monthlyTrend) && d.monthlyTrend.length === 12, 'monthlyTrend has 12 months')
  ok(Array.isArray(d.recentPayments), `recentPayments (${d.recentPayments?.length})`)
  // source filter honoured
  if (query.source === 'manual') ok(d.gatewayReceivedPKR === 0, 'manual filter → gateway zeroed')
  if (query.source === 'gateway') ok(d.manualReceivedPKR === 0, 'gateway filter → manual zeroed')
  return d
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('Connected to', mongoose.connection.name)

  const now = new Date()
  await run({}, 'default (current month)')
  await run({ year: String(now.getFullYear()), month: 'all' }, 'whole year')
  await run({ month: 'all', source: 'manual' }, 'manual only')
  await run({ month: 'all', source: 'gateway' }, 'gateway only')

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  await mongoose.disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error('FATAL', e); await mongoose.disconnect(); process.exit(1) })

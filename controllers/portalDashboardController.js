import Student from '../models/Student.js'
import TutorProfile from '../models/TutorProfile.js'
import ClassSession from '../models/ClassSession.js'
import AdmissionApplication from '../models/AdmissionApplication.js'
import LessonEntry from '../models/LessonEntry.js'
import Payment from '../models/Payment.js'
import Expense from '../models/Expense.js'
import FeePayment from '../models/FeePayment.js'
import SalaryRecord from '../models/SalaryRecord.js'
import CurrencyRates from '../models/CurrencyRates.js'
import { CURRENCIES, getRates, getRatesDoc, clearRatesCache, toPKRWith } from '../services/currencyRates.js'
import { monthlyFee } from '../utils/feeDue.js'
import { duesSummary } from '../services/feeDues.js'

// Helper: last N months labels + boundaries
function lastNMonths(n) {
  const months = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({
      label: d.toLocaleString('en', { month: 'short' }),
      start: new Date(d.getFullYear(), d.getMonth(), 1),
      end: new Date(d.getFullYear(), d.getMonth() + 1, 1),
    })
  }
  return months
}

// Helper: last 7 days labels + boundaries
function last7Days() {
  const days = []
  const now = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    d.setHours(0, 0, 0, 0)
    const end = new Date(d)
    end.setDate(end.getDate() + 1)
    days.push({
      label: d.toLocaleString('en', { weekday: 'short' }),
      start: d,
      end,
    })
  }
  return days
}

/**
 * GET /api/portal/dashboard/charts
 * Returns chart-ready data based on user role.
 */
export async function getDashboardCharts(req, res) {
  try {
    const user = req.user
    const roles = (user.roles || []).map(r => r?.key || r)
    const isAdmin = roles.some(r => ['super_admin', 'admin', 'coordinator'].includes(r))
    const isTutor = roles.includes('tutor')
    const isStudent = roles.includes('student')

    // Parse months param (default 6, 0 = all time)
    const raw = parseInt(req.query.months)
    const months = raw === 0 ? 0 : Math.min(Math.max(raw || 6, 1), 120)

    if (isAdmin) {
      return await adminCharts(req, res, months)
    } else if (isTutor) {
      return await tutorCharts(req, res, user, months)
    } else if (isStudent) {
      return await studentCharts(req, res, user, months)
    }

    res.json({})
  } catch (err) {
    console.error('Dashboard charts error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

async function adminCharts(_req, res, monthCount) {
  const months = lastNMonths(monthCount || 120)
  const days = last7Days()
  const rangeStart = months[0].start

  const [
    studentStatusAgg,
    courseAgg,
    monthlyEnrollments,
    dailySessions,
    sessionStatusAgg,
    admissionMonthly,
    tutorSkillAgg,
  ] = await Promise.all([
    // Student status distribution
    Student.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),

    // Students by course
    Student.aggregate([
      { $match: { status: 'active' } },
      { $unwind: '$courseLabels' },
      { $group: { _id: '$courseLabels', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    // Monthly new student enrollments (by joiningDate)
    Student.aggregate([
      { $match: { joiningDate: { $gte: rangeStart } } },
      {
        $group: {
          _id: { y: { $year: '$joiningDate' }, m: { $month: '$joiningDate' } },
          count: { $sum: 1 },
        },
      },
    ]),

    // Daily sessions last 7 days
    ClassSession.aggregate([
      { $match: { date: { $gte: days[0].start } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
            status: '$status',
          },
          count: { $sum: 1 },
        },
      },
    ]),

    // Overall session status distribution
    ClassSession.aggregate([
      { $match: { date: { $gte: rangeStart } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),

    // Monthly admissions
    AdmissionApplication.aggregate([
      { $match: { createdAt: { $gte: rangeStart } } },
      {
        $group: {
          _id: {
            y: { $year: '$createdAt' },
            m: { $month: '$createdAt' },
            status: '$status',
          },
          count: { $sum: 1 },
        },
      },
    ]),

    // Tutor skill level distribution
    TutorProfile.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: '$skillLevel', count: { $sum: 1 } } },
    ]),
  ])

  // Map monthly enrollments to labels
  const enrollmentTrend = months.map(m => {
    const match = monthlyEnrollments.find(
      e => e._id.m === m.start.getMonth() + 1 && e._id.y === m.start.getFullYear()
    )
    return { label: m.label, value: match?.count || 0 }
  })

  // Map daily sessions
  const dailyCompleted = days.map(d => {
    const dateStr = d.start.toISOString().split('T')[0]
    const match = dailySessions.find(s => s._id.date === dateStr && s._id.status === 'completed')
    return match?.count || 0
  })
  const dailyMissed = days.map(d => {
    const dateStr = d.start.toISOString().split('T')[0]
    const match = dailySessions.find(s => s._id.date === dateStr && s._id.status === 'missed')
    return match?.count || 0
  })
  const dailyScheduled = days.map(d => {
    const dateStr = d.start.toISOString().split('T')[0]
    const total = dailySessions.filter(s => s._id.date === dateStr).reduce((a, b) => a + b.count, 0)
    return total
  })

  // Map admissions monthly
  const admissionsTrend = months.map(m => {
    const pending = admissionMonthly.find(
      a => a._id.m === m.start.getMonth() + 1 && a._id.y === m.start.getFullYear() && a._id.status === 'pending'
    )?.count || 0
    const approved = admissionMonthly.find(
      a => a._id.m === m.start.getMonth() + 1 && a._id.y === m.start.getFullYear() && a._id.status === 'approved'
    )?.count || 0
    const rejected = admissionMonthly.find(
      a => a._id.m === m.start.getMonth() + 1 && a._id.y === m.start.getFullYear() && a._id.status === 'rejected'
    )?.count || 0
    return { label: m.label, pending, approved, rejected }
  })

  // Status maps
  const statusMap = {}
  studentStatusAgg.forEach(s => { statusMap[s._id] = s.count })

  const sessionStatusMap = {}
  sessionStatusAgg.forEach(s => { sessionStatusMap[s._id] = s.count })

  const courseMap = {}
  courseAgg.forEach(c => { courseMap[c._id] = c.count })

  const skillMap = {}
  tutorSkillAgg.forEach(s => { skillMap[s._id || 'unset'] = s.count })

  res.json({
    enrollmentTrend,
    studentStatus: statusMap,
    courseDistribution: courseMap,
    dailySessions: {
      labels: days.map(d => d.label),
      completed: dailyCompleted,
      missed: dailyMissed,
      total: dailyScheduled,
    },
    sessionStatus: sessionStatusMap,
    admissionsTrend,
    tutorSkills: skillMap,
  })
}

async function tutorCharts(_req, res, user, monthCount) {
  const days = last7Days()
  const months = lastNMonths(monthCount || 120)
  const rangeStart = months[0].start

  const tutorId = user.linkedTutorId
  if (!tutorId) return res.json({})

  const [dailySessions, monthlyLessons, statusAgg] = await Promise.all([
    // Daily sessions this week
    ClassSession.aggregate([
      { $match: { tutorId: tutorId, date: { $gte: days[0].start } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
            status: '$status',
          },
          count: { $sum: 1 },
        },
      },
    ]),

    // Monthly lesson entries
    LessonEntry.aggregate([
      { $match: { tutorId: tutorId, date: { $gte: rangeStart } } },
      {
        $group: {
          _id: { y: { $year: '$date' }, m: { $month: '$date' } },
          count: { $sum: 1 },
        },
      },
    ]),

    // Session status distribution (last 30 days)
    ClassSession.aggregate([
      {
        $match: {
          tutorId: tutorId,
          date: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ])

  const weeklyCompleted = days.map(d => {
    const dateStr = d.start.toISOString().split('T')[0]
    return dailySessions.find(s => s._id.date === dateStr && s._id.status === 'completed')?.count || 0
  })
  const weeklyMissed = days.map(d => {
    const dateStr = d.start.toISOString().split('T')[0]
    return dailySessions.find(s => s._id.date === dateStr && s._id.status === 'missed')?.count || 0
  })

  const lessonTrend = months.map(m => {
    const match = monthlyLessons.find(
      e => e._id.m === m.start.getMonth() + 1 && e._id.y === m.start.getFullYear()
    )
    return { label: m.label, value: match?.count || 0 }
  })

  const sessionStatusMap = {}
  statusAgg.forEach(s => { sessionStatusMap[s._id] = s.count })

  res.json({
    weeklySessions: {
      labels: days.map(d => d.label),
      completed: weeklyCompleted,
      missed: weeklyMissed,
    },
    lessonTrend,
    sessionStatus: sessionStatusMap,
  })
}

async function studentCharts(_req, res, user, monthCount) {
  if (!user.linkedStudentId) return res.json({})

  const months = lastNMonths(monthCount || 120)
  const rangeStart = months[0].start

  const [monthlyLessons, sessionStatusAgg] = await Promise.all([
    LessonEntry.aggregate([
      { $match: { studentId: user.linkedStudentId, date: { $gte: rangeStart } } },
      {
        $group: {
          _id: { y: { $year: '$date' }, m: { $month: '$date' } },
          count: { $sum: 1 },
        },
      },
    ]),

    ClassSession.aggregate([
      { $match: { studentId: user.linkedStudentId, date: { $gte: rangeStart } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ])

  const lessonTrend = months.map(m => {
    const match = monthlyLessons.find(
      e => e._id.m === m.start.getMonth() + 1 && e._id.y === m.start.getFullYear()
    )
    return { label: m.label, value: match?.count || 0 }
  })

  const sessionStatusMap = {}
  sessionStatusAgg.forEach(s => { sessionStatusMap[s._id] = s.count })

  res.json({
    lessonTrend,
    sessionStatus: sessionStatusMap,
  })
}

// Supported currencies. Every multi-currency figure is rolled up into one PKR
// headline at the conversion rates the admin enters on the Revenue page
// (models/CurrencyRates.js, client's request 2026-11-07); they used to be
// hard-coded here.
const REVENUE_CURRENCIES = CURRENCIES

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ── Revenue ledger ──────────────────────────────────────────────────────────
// Every revenue figure is built from ONE month-bucketed ledger: the four money
// collections are each aggregated once by (year, month, …) and folded into
// per-month buckets keyed by a month index (year*12 + month-1). The selected
// period, the 12-month trend, the rolling history the forecast reads and the
// previous-period comparison are then all sums over index ranges, so they can
// never disagree with each other.
//
// Months are cut in Pakistan time: a card payment at 23:30 UTC on 30 Sep is an
// October receipt for the academy.
const REVENUE_TZ = '+05:00'
const PK_OFFSET_MS = 5 * 3600 * 1000
const monthIdx = (year, month) => year * 12 + (month - 1)
const idxToYM = (i) => ({ year: Math.floor(i / 12), month: (i % 12) + 1 })
const tzYear = (field) => ({ $year: { date: field, timezone: REVENUE_TZ } })
const tzMonth = (field) => ({ $month: { date: field, timezone: REVENUE_TZ } })
// Older card payments predate the `gateway` field; STRIPE as the method is the tell.
const GATEWAY_OF = { $ifNull: ['$gateway', { $cond: [{ $eq: ['$paymentMethod', 'STRIPE'] }, 'stripe', 'mastercard'] }] }
const GATEWAY_LABELS = { stripe: 'Stripe', mastercard: 'Mastercard' }
const METHOD_LABELS = {
  website: 'Website (Stripe)', western_union: 'Western Union', moneygram: 'MoneyGram', ria: 'Ria',
  remitly: 'Remitly', wise: 'Wise', taptap_send: 'Taptap Send', paypal: 'PayPal', zelle: 'Zelle',
  online_transfer: 'Online transfer',
  bank_transfer: 'Bank transfer', cash: 'Cash', card: 'Card (manual)', jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa', cheque: 'Cheque', other: 'Other',
}
const SALARY_TYPES = ['tutor', 'staff', 'custom']

const blankMonth = () => ({
  manual: 0, gateway: 0, manualCount: 0, gatewayCount: 0,
  salary: { tutor: 0, staff: 0, custom: 0 }, salaryCount: 0, salaryPending: 0,
  otherExpense: 0,
  gatewayByCurrency: {}, // currency → { total, count, stripe, mastercard } in the payment's own currency
  manualByCurrency: {},  // currency → { total, count } in the payment's own currency
  channels: {},          // 'manual:cash' | 'gateway:stripe' → { pkr, count }
  expenseByCategory: {}, // category → { pkr, count }
})

async function loadRevenueLedger(toPKR) {
  const [manualAgg, gatewayAgg, expenseAgg, salaryAgg] = await Promise.all([
    // A FeePayment that wraps a gateway Payment (linkedPaymentId) is the same
    // money already counted on the gateway side — skip it or it counts twice.
    FeePayment.aggregate([
      { $match: { linkedPaymentId: null } },
      { $group: { _id: { y: tzYear('$paidAt'), m: tzMonth('$paidAt'), currency: '$currency', method: '$method' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: { y: tzYear('$createdAt'), m: tzMonth('$createdAt'), currency: '$currency', gateway: GATEWAY_OF }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Expense.aggregate([
      { $match: { type: 'expense' } },
      { $group: { _id: { y: tzYear('$date'), m: tzMonth('$date'), currency: '$currency', category: '$category' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    SalaryRecord.aggregate([
      { $group: { _id: { y: '$year', m: '$month', type: { $ifNull: ['$subjectType', 'tutor'] }, currency: '$currency', status: '$status' }, total: { $sum: '$netPayable' }, count: { $sum: 1 } } },
    ]),
  ])

  const months = new Map()
  const at = (i) => { if (!months.has(i)) months.set(i, blankMonth()); return months.get(i) }
  const addChannel = (b, key, pkr, count) => {
    const c = b.channels[key] || (b.channels[key] = { pkr: 0, count: 0 })
    c.pkr += pkr; c.count += count
  }

  for (const r of manualAgg) {
    if (!r._id.y) continue
    const b = at(monthIdx(r._id.y, r._id.m))
    const pkr = toPKR(r.total, r._id.currency || 'PKR')
    b.manual += pkr
    b.manualCount += r.count
    const mcur = r._id.currency || 'PKR'
    const mc = b.manualByCurrency[mcur] || (b.manualByCurrency[mcur] = { total: 0, count: 0 })
    mc.total += r.total; mc.count += r.count
    addChannel(b, `manual:${r._id.method || 'other'}`, pkr, r.count)
  }
  for (const r of gatewayAgg) {
    if (!r._id.y) continue
    const b = at(monthIdx(r._id.y, r._id.m))
    const cur = r._id.currency || 'PKR'
    const pkr = toPKR(r.total, cur)
    b.gateway += pkr
    b.gatewayCount += r.count
    const g = b.gatewayByCurrency[cur] || (b.gatewayByCurrency[cur] = { total: 0, count: 0, stripe: 0, mastercard: 0 })
    g.total += r.total; g.count += r.count; g[r._id.gateway] = (g[r._id.gateway] || 0) + r.total
    addChannel(b, `gateway:${r._id.gateway}`, pkr, r.count)
  }
  for (const r of expenseAgg) {
    if (!r._id.y) continue
    const b = at(monthIdx(r._id.y, r._id.m))
    const pkr = toPKR(r.total, r._id.currency || 'PKR')
    b.otherExpense += pkr
    const c = b.expenseByCategory[r._id.category] || (b.expenseByCategory[r._id.category] = { pkr: 0, count: 0 })
    c.pkr += pkr; c.count += r.count
  }
  // Salaries are a cash outflow in the month AFTER their pay period: July's
  // salary is handed out in early August, so it lands in the August bucket.
  // Only PAID records are an expense; draft/finalized ones are carried as
  // `salaryPending` (still owed for that payout month) so the page can say so.
  for (const r of salaryAgg) {
    if (!r._id.y || !r._id.m) continue
    const b = at(monthIdx(r._id.y, r._id.m) + 1)
    const pkr = toPKR(r.total, r._id.currency || 'PKR')
    if (r._id.status === 'paid') {
      const type = SALARY_TYPES.includes(r._id.type) ? r._id.type : 'custom'
      b.salary[type] += pkr
      b.salaryCount += r.count
    } else {
      b.salaryPending += pkr
    }
  }
  return months
}

// Fold the buckets for month indexes [from, to] into one bucket.
function sumLedger(ledger, from, to) {
  const out = blankMonth()
  const merge = (target, src, keys) => {
    for (const [k, v] of Object.entries(src)) {
      const o = target[k] || (target[k] = Object.fromEntries(keys.map(x => [x, 0])))
      for (const x of keys) o[x] += v[x] || 0
    }
  }
  for (let i = from; i <= to; i++) {
    const b = ledger.get(i)
    if (!b) continue
    out.manual += b.manual; out.gateway += b.gateway
    out.manualCount += b.manualCount; out.gatewayCount += b.gatewayCount
    for (const t of SALARY_TYPES) out.salary[t] += b.salary[t]
    out.salaryCount += b.salaryCount; out.salaryPending += b.salaryPending
    out.otherExpense += b.otherExpense
    merge(out.gatewayByCurrency, b.gatewayByCurrency, ['total', 'count', 'stripe', 'mastercard'])
    merge(out.manualByCurrency, b.manualByCurrency, ['total', 'count'])
    merge(out.channels, b.channels, ['pkr', 'count'])
    merge(out.expenseByCategory, b.expenseByCategory, ['pkr', 'count'])
  }
  return out
}

const salaryTotal = (b) => b.salary.tutor + b.salary.staff + b.salary.custom
const round = (n) => Math.round(n || 0)
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null)

// One flat chart/table row for a month.
function seriesRow(ledger, i, currentIdx) {
  const { year, month } = idxToYM(i)
  const b = ledger.get(i) || blankMonth()
  const received = b.manual + b.gateway
  const salary = salaryTotal(b)
  const expense = salary + b.otherExpense
  const net = received - expense
  return {
    year, month,
    key: `${year}-${String(month).padStart(2, '0')}`,
    label: MONTH_LABELS[month - 1],
    received: round(received), manual: round(b.manual), gateway: round(b.gateway),
    payments: b.manualCount + b.gatewayCount,
    salary: round(salary),
    salaryTutor: round(b.salary.tutor), salaryStaff: round(b.salary.staff), salaryCustom: round(b.salary.custom),
    salaryPending: round(b.salaryPending),
    otherExpense: round(b.otherExpense),
    expense: round(expense),
    net: round(net),
    margin: pct(net, received),
    partial: i === currentIdx, // the month still in progress
    future: i > currentIdx,
  }
}

/**
 * GET /api/portal/dashboard/revenue
 * Revenue = fees received, from two sources combined:
 *   - Manual fees  → FeePayment (bank transfer / cash / cheque, recorded by hand)
 *   - Gateway fees → Payment (status 'completed', Stripe / Mastercard)
 * Expenses = paid salaries (tutor + staff + off-portal, shifted to their payout
 * month) + manually logged operating expenses. Filters: year + fromMonth..toMonth.
 *
 * The per-currency breakdown (`receivedByCurrency`) is deliberately GATEWAY-ONLY:
 * a gateway charge's currency is what the card was actually billed in, whereas a
 * manual record's currency is whatever the person typing it picked.
 */
export async function getRevenueStats(req, res) {
  try {
    const now = new Date()
    const year = parseInt(req.query.year, 10) || now.getFullYear()

    // Period is a month range within the year: fromMonth..toMonth (1-12, inclusive),
    // which supports the Month / Quarter / Year selector on the page. The older
    // `month` / `month=all` params still work (mapped onto the range) for back-compat.
    let fromMonth, toMonth
    if (req.query.fromMonth != null || req.query.toMonth != null) {
      fromMonth = Math.min(12, Math.max(1, parseInt(req.query.fromMonth, 10) || 1))
      toMonth = Math.max(fromMonth, Math.min(12, Math.max(1, parseInt(req.query.toMonth, 10) || 12)))
    } else {
      const monthParam = req.query.month
      const isWholeYear = monthParam === 'all' || monthParam === '0'
      const m = isWholeYear ? null : Math.min(12, Math.max(1, parseInt(monthParam, 10) || (now.getMonth() + 1)))
      fromMonth = isWholeYear ? 1 : m
      toMonth = isWholeYear ? 12 : m
    }
    const wholeYear = fromMonth === 1 && toMonth === 12

    // "Now" in Pakistan time, to match how the ledger cuts months.
    const pkNow = new Date(now.getTime() + PK_OFFSET_MS)
    const currentIdx = monthIdx(pkNow.getUTCFullYear(), pkNow.getUTCMonth() + 1)

    const rates = await getRates()
    const toPKR = toPKRWith(rates)
    const ledger = await loadRevenueLedger(toPKR)

    // ── 1. The selected period ──
    const startIdx = monthIdx(year, fromMonth)
    const endIdx = monthIdx(year, toMonth)
    const span = endIdx - startIdx + 1
    const p = sumLedger(ledger, startIdx, endIdx)

    const totalReceivedPKR = p.manual + p.gateway
    const paymentCount = p.manualCount + p.gatewayCount
    const salaryPKR = salaryTotal(p)
    const totalExpensePKR = salaryPKR + p.otherExpense
    const netProfitPKR = totalReceivedPKR - totalExpensePKR

    // Everything received, per currency it was paid in (manual + gateway), and
    // its PKR value at the admin's rates. `stripe` / `mastercard` split the
    // gateway part.
    const receivedByCurrency = REVENUE_CURRENCIES.map(c => {
      const g = p.gatewayByCurrency[c] || { total: 0, count: 0, stripe: 0, mastercard: 0 }
      const m = p.manualByCurrency[c] || { total: 0, count: 0 }
      return {
        currency: c, rate: rates[c] || 1,
        total: g.total + m.total, count: g.count + m.count,
        manual: m.total, manualCount: m.count,
        gateway: g.total, gatewayCount: g.count,
        stripe: g.stripe, mastercard: g.mastercard,
        pkrEquiv: round(toPKR(g.total + m.total, c)),
      }
    })

    const receivedByChannel = Object.entries(p.channels).map(([key, c]) => {
      const [source, name] = key.split(':')
      return {
        key, source,
        label: source === 'gateway' ? (GATEWAY_LABELS[name] || name) : (METHOD_LABELS[name] || name),
        total: round(c.pkr), count: c.count,
      }
    }).sort((a, b) => b.total - a.total)

    const expenseByCategory = Object.entries(p.expenseByCategory)
      .map(([category, c]) => ({ category, total: round(c.pkr), count: c.count }))
      .sort((a, b) => b.total - a.total)

    // ── 2. The same-length period immediately before (for % change) ──
    const prev = sumLedger(ledger, startIdx - span, startIdx - 1)
    const prevReceived = prev.manual + prev.gateway
    const prevSalary = salaryTotal(prev)
    const prevExpense = prevSalary + prev.otherExpense
    const prevFrom = idxToYM(startIdx - span), prevTo = idxToYM(startIdx - 1)
    const previous = {
      label: span === 1 ? `${MONTH_LABELS[prevFrom.month - 1]} ${prevFrom.year}`
        : `${MONTH_LABELS[prevFrom.month - 1]} ${prevFrom.year}–${MONTH_LABELS[prevTo.month - 1]} ${prevTo.year}`,
      receivedPKR: round(prevReceived),
      salaryPKR: round(prevSalary),
      expenseOnlyPKR: round(prev.otherExpense),
      expensePKR: round(prevExpense),
      netProfitPKR: round(prevReceived - prevExpense),
    }

    // ── 3. Total fee of students (current agreed monthly fee, a snapshot) ──
    // On this branch the fee is what the fee grid bills: the billed amount in
    // the student's billing currency (utils/feeDue.js#monthlyFee), or the rupee
    // fee when no billed amount is set.
    const feeStudents = await Student.find({ status: { $in: ['active', 'leave'] } })
      .select('billing.fee billing.amount billing.currency').lean()
    const feeCurAgg = {} // currency -> { total, count }
    let totalFeePKR = 0
    for (const s of feeStudents) {
      const fee = monthlyFee(s)
      const cur = s.billing?.amount > 0 ? (s.billing.currency || 'PKR') : 'PKR'
      const bucket = feeCurAgg[cur] || (feeCurAgg[cur] = { total: 0, count: 0 })
      bucket.total += fee
      bucket.count += 1
      totalFeePKR += toPKR(fee, cur)
    }
    const totalFeeByCurrency = REVENUE_CURRENCIES.map(c => ({
      currency: c, total: feeCurAgg[c]?.total || 0, count: feeCurAgg[c]?.count || 0,
    }))
    const studentCount = feeStudents.length
    const avgFeePerStudentPKR = studentCount > 0 ? totalFeePKR / studentCount : 0

    // Collection rate: received vs. what the current roll would bill over the
    // months of the period that have actually started (a future month expects nothing).
    const elapsedMonths = Math.max(0, Math.min(endIdx, currentIdx) - startIdx + 1)
    const expectedFeePKR = totalFeePKR * elapsedMonths

    // ── 4. Series ──
    const monthlyTrend = Array.from({ length: 12 }, (_, i) => seriesRow(ledger, monthIdx(year, i + 1), currentIdx))
    // Rolling 24 months ending with the current month — what the forecast reads.
    const history = Array.from({ length: 24 }, (_, i) => seriesRow(ledger, currentIdx - 23 + i, currentIdx))

    // ── 5. Recent payments in the period (combined + tagged) ──
    // Period bounds as PKT midnights, to match the ledger.
    const periodStart = new Date(Date.UTC(year, fromMonth - 1, 1) - PK_OFFSET_MS)
    const periodEnd = new Date(Date.UTC(year, toMonth, 1) - PK_OFFSET_MS)
    const [recentManual, recentGateway] = await Promise.all([
      FeePayment.find({ paidAt: { $gte: periodStart, $lt: periodEnd }, linkedPaymentId: null })
        .sort({ paidAt: -1 }).limit(20)
        .select('amount currency method payerName reference paidAt').lean(),
      Payment.find({ status: 'completed', createdAt: { $gte: periodStart, $lt: periodEnd } })
        .sort({ createdAt: -1 }).limit(20)
        .select('amount currency paymentMethod gateway studentName createdAt').lean(),
    ])
    const recentPayments = [
      ...recentManual.map(r => ({ name: r.payerName || r.reference || '—', amount: r.amount, currency: r.currency, method: METHOD_LABELS[r.method] || r.method, source: 'manual', date: r.paidAt })),
      ...recentGateway.map(r => {
        const gw = r.gateway || (r.paymentMethod === 'STRIPE' ? 'stripe' : 'mastercard')
        return { name: r.studentName || '—', amount: r.amount, currency: r.currency, method: GATEWAY_LABELS[gw] || gw, source: 'gateway', date: r.createdAt }
      }),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20)

    const [ratesDoc, dues] = await Promise.all([getRatesDoc(), duesSummary({ days: 7 })])

    res.json({
      period: {
        year, fromMonth, toMonth, wholeYear, months: span, elapsedMonths,
        month: fromMonth === toMonth ? fromMonth : null,
        label: wholeYear ? `${year}`
          : fromMonth === toMonth ? `${MONTH_LABELS[fromMonth - 1]} ${year}`
            : `${MONTH_LABELS[fromMonth - 1]}–${MONTH_LABELS[toMonth - 1]} ${year}`,
      },
      conversionRates: rates,
      ratesUpdatedAt: ratesDoc.updatedAt || null,
      ratesUpdatedBy: ratesDoc.updatedByName || '',
      currencies: REVENUE_CURRENCIES,
      // Unpaid fees right now (overdue, due today, next 7 days), per currency and in PKR.
      outstanding: { overdue: dues.totals.overdue, today: dues.totals.today, upcoming: dues.totals.upcoming, asOf: dues.today },

      // Student fees (snapshot)
      totalFeePKR: round(totalFeePKR),
      totalFeeByCurrency,
      studentCount,
      avgFeePerStudentPKR: round(avgFeePerStudentPKR),
      expectedFeePKR: round(expectedFeePKR),
      collectionRatePct: pct(totalReceivedPKR, expectedFeePKR),

      // Received (manual + gateway)
      totalReceivedPKR: round(totalReceivedPKR),
      manualReceivedPKR: round(p.manual),
      gatewayReceivedPKR: round(p.gateway),
      paymentCount,
      avgReceivedPerPayment: paymentCount > 0 ? round(totalReceivedPKR / paymentCount) : 0,
      receivedByCurrency,
      currencyBasis: 'all',
      receivedByChannel,

      // Expenses: paid salaries (by subject type) + logged operating expenses
      salaryPKR: round(salaryPKR),
      salaryByType: { tutor: round(p.salary.tutor), staff: round(p.salary.staff), custom: round(p.salary.custom) },
      salaryCount: p.salaryCount,
      salaryPendingPKR: round(p.salaryPending),
      expenseOnlyPKR: round(p.otherExpense),
      totalExpensePKR: round(totalExpensePKR),
      expenseByCategory,

      // Net
      netProfitPKR: round(netProfitPKR),
      profitMarginPct: pct(netProfitPKR, totalReceivedPKR),

      previous,
      monthlyTrend,
      history,
      recentPayments,
    })
  } catch (err) {
    console.error('Revenue stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/dashboard/currency-rates — the PKR conversion rates (revenue.read)
export async function getCurrencyRates(_req, res) {
  try {
    const doc = await getRatesDoc()
    res.json({ rates: await getRates(), updatedAt: doc.updatedAt || null, updatedBy: doc.updatedByName || '', currencies: CURRENCIES })
  } catch (err) {
    console.error('Currency rates error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// PUT /portal/dashboard/currency-rates { rates: { USD: 280, GBP: 356, ... } } (revenue.manage)
export async function updateCurrencyRates(req, res) {
  try {
    const input = req.body?.rates || {}
    const set = {}
    for (const c of CURRENCIES) {
      if (c === 'PKR' || input[c] === undefined || input[c] === '') continue
      const v = Number(input[c])
      if (!(v > 0) || v > 100000) return res.status(400).json({ error: `Enter a rate above 0 for ${c}` })
      set[`rates.${c}`] = Math.round(v * 10000) / 10000
    }
    if (!Object.keys(set).length) return res.status(400).json({ error: 'No rates to save' })
    await CurrencyRates.updateOne(
      { key: 'default' },
      { $set: { ...set, updatedBy: req.userId, updatedByName: req.user?.displayName || '' } },
      { upsert: true },
    )
    clearRatesCache()
    const doc = await getRatesDoc()
    res.json({ rates: await getRates(), updatedAt: doc.updatedAt || null, updatedBy: doc.updatedByName || '', currencies: CURRENCIES })
  } catch (err) {
    console.error('Update currency rates error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

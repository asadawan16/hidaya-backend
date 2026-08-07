import Student from '../models/Student.js'
import TutorProfile from '../models/TutorProfile.js'
import ClassSession from '../models/ClassSession.js'
import AdmissionApplication from '../models/AdmissionApplication.js'
import LessonEntry from '../models/LessonEntry.js'
import Payment from '../models/Payment.js'
import Expense from '../models/Expense.js'
import FeePayment from '../models/FeePayment.js'
import SalaryRecord from '../models/SalaryRecord.js'

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

// Supported currencies + approximate PKR conversion rates. Used to roll the
// multi-currency figures up into a single PKR-equivalent headline number.
const REVENUE_CURRENCIES = ['PKR', 'USD', 'EUR', 'GBP', 'CAD']
const PKR_RATES = { PKR: 1, USD: 278, EUR: 312, GBP: 355, CAD: 205 }
const toPKR = (amount, cur) => (amount || 0) * (PKR_RATES[cur] || 1)

// The students page lets a fee be tagged with a foreign currency, but in practice
// almost every agreed fee is entered as a PKR amount (fees are collected in PKR on
// the fee-management page). A genuine foreign monthly fee is a small number
// ($20–80 / £15–60); a PKR fee is in the thousands. So a "foreign" label sitting on
// a thousands-range fee is a data-entry mislabel — the value is really PKR and must
// NOT be multiplied by the FX rate (that's what inflated Total/Avg fee to millions).
// We therefore trust a foreign label only when the amount is small enough to plausibly
// be that currency; anything at or above this cap is treated as PKR.
const FOREIGN_FEE_MAX = 500
const effectiveFeeCurrency = (fee, currency) => {
  if (!currency || currency === 'PKR') return 'PKR'
  return (fee || 0) < FOREIGN_FEE_MAX ? currency : 'PKR'
}
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * GET /api/portal/dashboard/revenue
 * Revenue = fees received. Two independent sources are combined:
 *   - Manual fees  → FeePayment (bank transfer / cash / cheque, recorded by hand)
 *   - Gateway fees → Payment (status 'completed', from payment links / Mastercard)
 * Expenses include paid staff salaries. Filters: year, month (or whole year),
 * and source (all | manual | gateway).
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

    const source = ['manual', 'gateway'].includes(req.query.source) ? req.query.source : 'all'
    const includeManual = source !== 'gateway'
    const includeGateway = source !== 'manual'

    // Selected-period boundaries (fromMonth..toMonth within the year). periodEnd is
    // exclusive: the first day of the month after toMonth (rolls to next Jan at 12).
    const periodStart = new Date(year, fromMonth - 1, 1)
    const periodEnd = new Date(year, toMonth, 1)
    // Whole-year boundaries (for the 12-month trend chart)
    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year + 1, 0, 1)

    // ── 1. Fees received in the period, per currency (both sources) ──
    const manualByCurrency = includeManual ? await FeePayment.aggregate([
      { $match: { paidAt: { $gte: periodStart, $lt: periodEnd } } },
      { $group: { _id: '$currency', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]) : []

    const gatewayByCurrency = includeGateway ? await Payment.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: periodStart, $lt: periodEnd } } },
      { $group: { _id: '$currency', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]) : []

    const manualMap = Object.fromEntries(manualByCurrency.map(r => [r._id || 'PKR', r]))
    const gatewayMap = Object.fromEntries(gatewayByCurrency.map(r => [r._id || 'PKR', r]))

    const receivedByCurrency = REVENUE_CURRENCIES.map(c => {
      const manual = manualMap[c]?.total || 0
      const gateway = gatewayMap[c]?.total || 0
      const count = (manualMap[c]?.count || 0) + (gatewayMap[c]?.count || 0)
      return { currency: c, manual, gateway, total: manual + gateway, count }
    })

    const manualReceivedPKR = manualByCurrency.reduce((s, r) => s + toPKR(r.total, r._id), 0)
    const gatewayReceivedPKR = gatewayByCurrency.reduce((s, r) => s + toPKR(r.total, r._id), 0)
    const totalReceivedPKR = manualReceivedPKR + gatewayReceivedPKR
    const paymentCount = manualByCurrency.reduce((s, r) => s + r.count, 0)
      + gatewayByCurrency.reduce((s, r) => s + r.count, 0)
    const avgReceivedPerPayment = paymentCount > 0 ? totalReceivedPKR / paymentCount : 0

    // ── 2. Expenses in the period (operating + paid salaries) ──
    const expenseByCurrency = await Expense.aggregate([
      { $match: { type: 'expense', date: { $gte: periodStart, $lt: periodEnd } } },
      { $group: { _id: '$currency', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ])
    const expenseByCategory = await Expense.aggregate([
      { $match: { type: 'expense', date: { $gte: periodStart, $lt: periodEnd } } },
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ])

    // Salaries are a cash outflow in the month AFTER their pay period: July's salary
    // is handed out in early August, so it counts as an August expense. SalaryRecord
    // is keyed by (month, year) of the pay period — shift forward one month (Dec →
    // Jan of the next year) when bucketing into the revenue/expense view. Paid only.
    const shiftPeriod = (m, y) => (m === 12 ? { month: 1, year: y + 1 } : { month: m + 1, year: y })
    // Salaries that can pay out within `year`: all of `year` plus the previous
    // December (which is handed out in January of `year`).
    const paidSalaries = await SalaryRecord.aggregate([
      { $match: { status: 'paid', $or: [{ year }, { year: year - 1, month: 12 }] } },
      { $group: { _id: { month: '$month', year: '$year', currency: '$currency' }, total: { $sum: '$netPayable' } } },
    ])
    // Bucket each paid salary into its cash-outflow month within `year`.
    const salaryByExpenseMonth = {} // month (1-12 of `year`) → PKR
    for (const r of paidSalaries) {
      const { month: em, year: ey } = shiftPeriod(r._id.month, r._id.year)
      if (ey !== year) continue // e.g. December of `year` pays out next January — not this year
      salaryByExpenseMonth[em] = (salaryByExpenseMonth[em] || 0) + toPKR(r.total, r._id.currency)
    }
    const salaryPKR = Object.entries(salaryByExpenseMonth)
      .filter(([m]) => Number(m) >= fromMonth && Number(m) <= toMonth)
      .reduce((s, [, v]) => s + v, 0)

    const expenseOnlyPKR = expenseByCurrency.reduce((s, r) => s + toPKR(r.total, r._id), 0)
    const totalExpensePKR = expenseOnlyPKR + salaryPKR
    const netProfitPKR = totalReceivedPKR - totalExpensePKR

    // ── 3. Total fee of students (current agreed monthly fee, a snapshot) ──
    // Grouped by each student's EFFECTIVE fee currency (see effectiveFeeCurrency):
    // a foreign label on a PKR-magnitude fee is a mislabel and counted as PKR, so
    // Total/Avg fee reflect real rupee figures instead of FX-inflated ones.
    const feeStudents = await Student.find({ status: { $in: ['active', 'leave'] } })
      .select('billing.fee billing.currency').lean()
    const feeCurAgg = {} // currency -> { total, count }
    let totalFeePKR = 0
    for (const s of feeStudents) {
      const fee = s.billing?.fee || 0
      const cur = effectiveFeeCurrency(fee, s.billing?.currency)
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

    // ── 4. 12-month trend for the selected year (PKR-equiv) ──
    const monthGroup = (dateField) => ([
      { $group: { _id: { month: { $month: dateField }, currency: '$currency' }, total: { $sum: '$amount' } } },
    ])
    const manualMonthlyAgg = includeManual ? await FeePayment.aggregate([
      { $match: { paidAt: { $gte: yearStart, $lt: yearEnd } } },
      ...monthGroup('$paidAt'),
    ]) : []
    const gatewayMonthlyAgg = includeGateway ? await Payment.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: yearStart, $lt: yearEnd } } },
      ...monthGroup('$createdAt'),
    ]) : []
    const expenseMonthlyAgg = await Expense.aggregate([
      { $match: { type: 'expense', date: { $gte: yearStart, $lt: yearEnd } } },
      ...monthGroup('$date'),
    ])
    const sumMonth = (agg, m) => agg.filter(a => a._id.month === m).reduce((s, a) => s + toPKR(a.total, a._id.currency), 0)
    const monthlyTrend = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1
      const manual = sumMonth(manualMonthlyAgg, m)
      const gateway = sumMonth(gatewayMonthlyAgg, m)
      // Salaries are shifted to their pay-out month (see salaryByExpenseMonth above).
      const expense = sumMonth(expenseMonthlyAgg, m) + (salaryByExpenseMonth[m] || 0)
      return { month: m, label: MONTH_LABELS[i], manual, gateway, received: manual + gateway, expense }
    })

    // ── 5. Recent payments in the period (combined + tagged) ──
    const recentManual = includeManual ? await FeePayment.find({ paidAt: { $gte: periodStart, $lt: periodEnd } })
      .sort({ paidAt: -1 }).limit(12)
      .select('amount currency method payerName reference paidAt').lean() : []
    const recentGateway = includeGateway ? await Payment.find({ status: 'completed', createdAt: { $gte: periodStart, $lt: periodEnd } })
      .sort({ createdAt: -1 }).limit(12)
      .select('amount currency paymentMethod studentName createdAt').lean() : []
    const recentPayments = [
      ...recentManual.map(p => ({ name: p.payerName || p.reference || '—', amount: p.amount, currency: p.currency, method: p.method, source: 'manual', date: p.paidAt })),
      ...recentGateway.map(p => ({ name: p.studentName || '—', amount: p.amount, currency: p.currency, method: p.paymentMethod, source: 'gateway', date: p.createdAt })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 12)

    res.json({
      period: {
        year, fromMonth, toMonth, wholeYear,
        month: fromMonth === toMonth ? fromMonth : null,
        label: wholeYear ? `${year}`
          : fromMonth === toMonth ? `${MONTH_LABELS[fromMonth - 1]} ${year}`
            : `${MONTH_LABELS[fromMonth - 1]}–${MONTH_LABELS[toMonth - 1]} ${year}`,
      },
      source,
      conversionRates: PKR_RATES,
      currencies: REVENUE_CURRENCIES,

      // Student fees (snapshot)
      totalFeePKR: Math.round(totalFeePKR),
      totalFeeByCurrency,
      studentCount,
      avgFeePerStudentPKR: Math.round(avgFeePerStudentPKR),

      // Received (manual + gateway)
      totalReceivedPKR: Math.round(totalReceivedPKR),
      manualReceivedPKR: Math.round(manualReceivedPKR),
      gatewayReceivedPKR: Math.round(gatewayReceivedPKR),
      paymentCount,
      avgReceivedPerPayment: Math.round(avgReceivedPerPayment),
      receivedByCurrency,

      // Expenses (incl. paid salaries)
      totalExpensePKR: Math.round(totalExpensePKR),
      expenseOnlyPKR: Math.round(expenseOnlyPKR),
      salaryPKR: Math.round(salaryPKR),
      expenseByCategory,

      // Net
      netProfitPKR: Math.round(netProfitPKR),

      monthlyTrend,
      recentPayments,
    })
  } catch (err) {
    console.error('Revenue stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

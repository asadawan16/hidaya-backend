import Student from '../models/Student.js'
import TutorProfile from '../models/TutorProfile.js'
import ClassSession from '../models/ClassSession.js'
import AdmissionApplication from '../models/AdmissionApplication.js'
import LessonEntry from '../models/LessonEntry.js'
import Payment from '../models/Payment.js'
import Invoice from '../models/Invoice.js'
import Expense from '../models/Expense.js'

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

/**
 * GET /api/portal/dashboard/revenue
 * Returns revenue/finance statistics for admin dashboard.
 */
export async function getRevenueStats(req, res) {
  try {
    const { dateFrom, dateTo, currency } = req.query

    // Build date filter
    const dateFilter = {}
    if (dateFrom) dateFilter.$gte = new Date(dateFrom)
    if (dateTo) dateFilter.$lte = new Date(dateTo)
    const hasDateFilter = Object.keys(dateFilter).length > 0

    const paymentMatch = { status: 'completed' }
    if (hasDateFilter) paymentMatch.createdAt = dateFilter
    if (currency) paymentMatch.currency = currency

    const expenseMatch = {}
    if (hasDateFilter) expenseMatch.date = dateFilter

    // 1. Revenue by currency (completed payments)
    const revenueByCurrency = await Payment.aggregate([
      { $match: paymentMatch },
      { $group: { _id: '$currency', total: { $sum: '$amount' }, count: { $sum: 1 }, avgAmount: { $avg: '$amount' } } },
      { $sort: { total: -1 } },
    ])

    // 2. Monthly revenue trend (last 12 months or date range)
    const monthlyRevenue = await Payment.aggregate([
      { $match: paymentMatch },
      { $group: {
        _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, currency: '$currency' },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      }},
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ])

    // 3. Payment status breakdown (all payments, not just completed)
    const allPaymentMatch = {}
    if (hasDateFilter) allPaymentMatch.createdAt = dateFilter
    const paymentsByStatus = await Payment.aggregate([
      { $match: allPaymentMatch },
      { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$amount' } } },
    ])

    // 4. Payment method breakdown
    const paymentsByMethod = await Payment.aggregate([
      { $match: paymentMatch },
      { $group: { _id: '$paymentMethod', count: { $sum: 1 }, total: { $sum: '$amount' } } },
    ])

    // 5. Invoice stats
    const invoiceMatch = {}
    if (hasDateFilter) invoiceMatch.createdAt = dateFilter
    const invoicesByStatus = await Invoice.aggregate([
      { $match: invoiceMatch },
      { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$amount' }, paid: { $sum: '$paidAmount' } } },
    ])

    // 6. Expenses vs Income
    const expenseVsIncome = await Expense.aggregate([
      { $match: expenseMatch },
      { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ])

    // 7. Monthly expenses trend
    const monthlyExpenses = await Expense.aggregate([
      { $match: expenseMatch },
      { $group: {
        _id: { year: { $year: '$date' }, month: { $month: '$date' }, type: '$type' },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      }},
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ])

    // 8. Expense by category
    const expenseByCategory = await Expense.aggregate([
      { $match: { ...expenseMatch, type: 'expense' } },
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ])

    // 9. Discount usage stats
    const discountStats = await Payment.aggregate([
      { $match: { ...paymentMatch, discountAmount: { $gt: 0 } } },
      { $group: {
        _id: '$discountCode',
        timesUsed: { $sum: 1 },
        totalDiscount: { $sum: '$discountAmount' },
        totalRevenue: { $sum: '$amount' },
      }},
      { $sort: { totalDiscount: -1 } },
      { $limit: 10 },
    ])

    // 10. Recent payments (last 10)
    const recentPayments = await Payment.find({ status: 'completed' })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('amount currency studentName studentEmail paymentMethod createdAt discountCode discountAmount')
      .lean()

    // PKR conversion rates (approximate live rates)
    const conversionRates = { PKR: 1, USD: 278, EUR: 312, GBP: 355 }

    // Total revenue in PKR
    const totalRevenuePKR = revenueByCurrency.reduce((sum, r) => {
      const rate = conversionRates[r._id] || 1
      return sum + (r.total * rate)
    }, 0)

    const totalExpenses = expenseVsIncome.find(e => e._id === 'expense')?.total || 0
    const totalIncome = expenseVsIncome.find(e => e._id === 'income')?.total || 0
    const totalPayments = paymentsByStatus.reduce((sum, s) => sum + s.count, 0)
    const completedPayments = paymentsByStatus.find(s => s._id === 'completed')?.count || 0
    const conversionRate = totalPayments > 0 ? Math.round((completedPayments / totalPayments) * 100) : 0

    res.json({
      conversionRates,
      totalRevenuePKR: Math.round(totalRevenuePKR),
      totalExpenses,
      totalIncome,
      netProfit: Math.round(totalRevenuePKR) - totalExpenses + totalIncome,
      paymentConversionRate: conversionRate,
      totalPayments,
      completedPayments,
      revenueByCurrency,
      monthlyRevenue,
      paymentsByStatus,
      paymentsByMethod,
      invoicesByStatus,
      expenseVsIncome,
      monthlyExpenses,
      expenseByCategory,
      discountStats,
      recentPayments,
    })
  } catch (err) {
    console.error('Revenue stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

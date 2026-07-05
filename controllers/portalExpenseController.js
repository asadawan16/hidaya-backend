import Expense from '../models/Expense.js'
import { logActivity } from '../utils/activityLogger.js'

export async function listExpenses(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { category, dateFrom, dateTo, type } = req.query

    const filter = {}
    if (category) filter.category = category
    if (type) filter.type = type
    if (dateFrom || dateTo) {
      filter.date = {}
      if (dateFrom) filter.date.$gte = new Date(dateFrom)
      if (dateTo) filter.date.$lte = new Date(dateTo)
    }

    const total = await Expense.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await Expense.find(filter)
      .populate('createdBy', 'displayName')
      .sort({ date: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List expenses error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createExpense(req, res) {
  try {
    const { title, category, amount, currency, date, description, receiptUrl, recurring, type } = req.body
    if (!title || !category || !amount || !date) {
      return res.status(400).json({ error: 'title, category, amount, and date are required' })
    }

    const expense = await Expense.create({
      title, category, amount,
      type: type || 'expense',
      currency: currency || 'PKR',
      date: new Date(date),
      description: description || '',
      receiptUrl: receiptUrl || '',
      recurring: recurring || false,
      createdBy: req.userId,
    })

    await logActivity({ level: 'info', category: 'expense', action: 'expense_created', message: `Expense logged: ${title} (${amount})`, req })

    const populated = await Expense.findById(expense._id).populate('createdBy', 'displayName').lean()
    res.status(201).json(populated)
  } catch (err) {
    console.error('Create expense error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateExpense(req, res) {
  try {
    const expense = await Expense.findById(req.params.id)
    if (!expense) return res.status(404).json({ error: 'Expense not found' })

    const fields = ['title', 'category', 'amount', 'currency', 'date', 'description', 'receiptUrl', 'recurring', 'type']
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        expense[f] = f === 'date' ? new Date(req.body[f]) : req.body[f]
      }
    }
    await expense.save()
    res.json(expense)
  } catch (err) {
    console.error('Update expense error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteExpense(req, res) {
  try {
    const expense = await Expense.findByIdAndDelete(req.params.id)
    if (!expense) return res.status(404).json({ error: 'Expense not found' })
    res.json({ message: 'Expense deleted' })
  } catch (err) {
    console.error('Delete expense error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getExpenseStats(req, res) {
  try {
    const { year, month, dateFrom, dateTo, groupBy } = req.query
    const unit = groupBy === 'week' ? 'week' : 'month'

    // Resolve the date range: explicit dateFrom/dateTo wins; else year/month; else all-time
    let start = null
    let end = null
    if (dateFrom || dateTo) {
      if (dateFrom) start = new Date(dateFrom)
      if (dateTo) { end = new Date(dateTo); end.setHours(23, 59, 59, 999) }
    } else if (year) {
      const y = Number(year)
      const m = month ? Number(month) : null
      if (m) { start = new Date(y, m - 1, 1); end = new Date(y, m, 0, 23, 59, 59, 999) }
      else { start = new Date(y, 0, 1); end = new Date(y, 11, 31, 23, 59, 59, 999) }
    }

    const matchStage = {}
    if (start || end) {
      matchStage.date = {}
      if (start) matchStage.date.$gte = start
      if (end) matchStage.date.$lte = end
    }
    const expenseMatch = { ...matchStage, type: 'expense' }

    const [byCategoryArr, trendArr, byType, totalsArr] = await Promise.all([
      // Category breakdown — expenses only
      Expense.aggregate([
        { $match: expenseMatch },
        { $group: { _id: '$category', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } },
      ]),
      // Trend — expenses only, bucketed by week or month
      Expense.aggregate([
        { $match: expenseMatch },
        { $group: { _id: { $dateTrunc: { date: '$date', unit, startOfWeek: 'monday' } }, total: { $sum: '$amount' } } },
        { $sort: { _id: 1 } },
      ]),
      // Income vs expense
      Expense.aggregate([
        { $match: matchStage },
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      // Expense totals for averaging
      Expense.aggregate([
        { $match: expenseMatch },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ])

    // Shape data to what the frontend consumes
    const byCategory = Object.fromEntries(byCategoryArr.map(c => [c._id, c.total]))
    const trend = trendArr.map(t => {
      const d = new Date(t._id)
      const label = unit === 'week'
        ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
      return { label, total: t.total }
    })

    const totalExpenses = totalsArr[0]?.total || 0
    const totalIncome = byType.find(t => t._id === 'income')?.total || 0

    // Average per month across the selected span
    let monthsSpan = 1
    if (start && end) {
      monthsSpan = Math.max(1, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1)
    } else if (unit === 'month') {
      monthsSpan = Math.max(1, trend.length)
    }
    const avgMonthly = Math.round(totalExpenses / monthsSpan)

    res.json({
      byCategory,
      trend,
      byType,
      totalExpenses,
      totalIncome,
      net: totalIncome - totalExpenses,
      avgMonthly,
      groupBy: unit,
      count: totalsArr[0]?.count || 0,
    })
  } catch (err) {
    console.error('Expense stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

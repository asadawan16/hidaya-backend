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
    const { year, month } = req.query
    const matchStage = {}
    if (year) {
      const y = Number(year)
      const m = month ? Number(month) : null
      if (m) {
        matchStage.date = {
          $gte: new Date(y, m - 1, 1),
          $lte: new Date(y, m, 0, 23, 59, 59),
        }
      } else {
        matchStage.date = {
          $gte: new Date(y, 0, 1),
          $lte: new Date(y, 11, 31, 23, 59, 59),
        }
      }
    }

    const [byCategory, byMonth, totals, byType] = await Promise.all([
      Expense.aggregate([
        { $match: matchStage },
        { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      Expense.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: { year: { $year: '$date' }, month: { $month: '$date' } },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),
      Expense.aggregate([
        { $match: matchStage },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Expense.aggregate([
        { $match: matchStage },
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ])

    res.json({
      byCategory,
      byMonth,
      byType,
      total: totals[0]?.total || 0,
      count: totals[0]?.count || 0,
    })
  } catch (err) {
    console.error('Expense stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

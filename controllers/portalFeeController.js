// Manual Fee Management — a yearly per-student grid of fee status, decoupled
// from the payment gateway (bank transfers / cash / mixed modes are recorded by
// hand). One FeePayment can be allocated across many months and many students
// (family relations), and can optionally wrap an existing gateway Payment.
import StudentFeeRecord from '../models/StudentFeeRecord.js'
import FeePayment from '../models/FeePayment.js'
import Student from '../models/Student.js'
import Family from '../models/Family.js'
import Payment from '../models/Payment.js'
import { logActivity } from '../utils/activityLogger.js'

function computeStatus(rec) {
  if (rec.status === 'waived') return 'waived'
  if (!rec.amountPaid || rec.amountPaid <= 0) return 'pending'
  if (rec.amount > 0 && rec.amountPaid < rec.amount) return 'partial'
  return 'received'
}

const clampMonth = (m) => Math.min(12, Math.max(1, parseInt(m, 10)))

// GET /portal/fees/grid — per-student fee grid scoped to a time period
// (a single month, a calendar quarter, or a whole year within `year`).
export async function getFeeGrid(req, res) {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear()
    const { familyId, studentId, search, studentStatus } = req.query
    // Period window inside the year (fromMonth..toMonth). Defaults to the whole year.
    const fromMonth = Math.min(12, Math.max(1, parseInt(req.query.fromMonth, 10) || 1))
    const toMonth = Math.max(fromMonth, Math.min(12, Math.max(1, parseInt(req.query.toMonth, 10) || 12)))
    // limit=all → no pagination (every matching student). Numeric limits clamp to 500.
    const showAll = req.query.limit === 'all'
    const limit = showAll ? 0 : Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25))
    const page = showAll ? 1 : Math.max(1, parseInt(req.query.page, 10) || 1)

    const filter = {}
    if (studentId) filter._id = studentId
    if (familyId) filter.familyId = familyId
    // Enrollment status filter. 'active' = present students (active + pending),
    // 'leave' = on-leave only, 'all' = everyone except left, 'left' = left only.
    if (studentStatus === 'left') filter.status = 'left'
    else if (studentStatus === 'leave') filter.status = 'leave'
    else if (studentStatus === 'active') filter.status = { $in: ['active', 'pending'] }
    else filter.status = { $ne: 'left' } // 'all' (and any fallback)
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ name: rx }, { rollNo: rx }]
    }

    // Per-billing-cycle counts across the current filter (before the cycle selection is
    // applied) so the cycle picker can show a stable breakdown. Unset/empty → 'monthly'
    // (the schema default).
    const cycleAgg = await Student.aggregate([{ $match: filter }, { $group: { _id: '$billing.cycle', n: { $sum: 1 } } }])
    const cycleCounts = {}
    for (const g of cycleAgg) { const key = g._id || 'monthly'; cycleCounts[key] = (cycleCounts[key] || 0) + g.n }

    // Scope to a specific billing cycle if requested (monthly also matches unset records).
    const cycle = req.query.cycle
    if (cycle === 'monthly') filter['billing.cycle'] = { $in: ['monthly', '', null] }
    else if (cycle) filter['billing.cycle'] = cycle

    // Fetch every matching student once (light projection). Summary KPIs are computed
    // across the whole filtered set so they stay accurate regardless of pagination;
    // the visible page is a slice of this list.
    const allStudents = await Student.find(filter)
      .select('name rollNo status familyId billing.fee billing.currency billing.cycle joiningDate createdAt')
      .populate('familyId', 'familyCode primaryGuardian')
      // Group family members next to each other (incl. on-leave siblings), then
      // alphabetical within the family. familyId null (solo students) sorts first.
      .sort({ familyId: 1, name: 1 })
      .lean()
    const total = allStudents.length
    const pageStudents = showAll ? allStudents : allStudents.slice((page - 1) * limit, (page - 1) * limit + limit)

    // Fee cells for the selected period only, across ALL matching students.
    const ids = allStudents.map(s => s._id)
    const cells = await StudentFeeRecord.find({ studentId: { $in: ids }, year, month: { $gte: fromMonth, $lte: toMonth } }).lean()
    const byStudent = {}
    for (const c of cells) {
      const k = c.studentId.toString()
      if (!byStudent[k]) byStudent[k] = {}
      byStudent[k][c.month] = {
        status: c.status, amount: c.amount, amountPaid: c.amountPaid,
        currency: c.currency, note: c.note, method: c.method, paidAt: c.paidAt,
      }
    }

    // Asia/Karachi "today" — the due boundary. Months after the current month don't
    // count towards due/receivable (nothing is owed yet for the future); past years
    // count all 12, future years count none.
    const kNow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const nowYear = Number(kNow.slice(0, 4))
    const nowMonth = Number(kNow.slice(5, 7))
    const monthLimit = year < nowYear ? 12 : (year === nowYear ? nowMonth : 0)

    // First month (within `year`) a student can be auto-billed: nothing is owed before
    // they joined. joiningDate is stored as a date-only value (UTC midnight), so read it
    // in UTC to avoid a timezone shifting the month. Older records without joiningDate
    // fall back to createdAt; if both are missing, don't restrict (month 1).
    // Returns 13 for a student who joins in a later year (nothing billable this year).
    function firstBillableMonth(s) {
      const jd = s.joiningDate || s.createdAt
      if (!jd) return 1
      const d = new Date(jd)
      if (isNaN(d.getTime())) return 1
      const jy = d.getUTCFullYear()
      if (jy < year) return 1
      if (jy > year) return 13
      return d.getUTCMonth() + 1
    }

    // Per-student figures for the selected period. Auto-fills months without a manual
    // record from the student's base fee (active students, months from joining up to today).
    function computeStudent(s) {
      const studentCells = byStudent[s._id.toString()] || {}
      const baseFee = s.billing?.fee || 0
      const isActive = s.status !== 'left'
      const joinMonth = firstBillableMonth(s)
      let periodDue = 0, periodCollected = 0, periodReceivable = 0
      const autoMonths = []
      for (let m = fromMonth; m <= toMonth; m++) {
        const cell = studentCells[m]
        const withinDue = m <= monthLimit
        if (cell) {
          periodCollected += cell.amountPaid || 0 // money in counts even for advance months
          if (cell.status === 'waived') continue
          if (withinDue) {
            periodReceivable += cell.amount || 0
            periodDue += Math.max(0, (cell.amount || 0) - (cell.amountPaid || 0))
          }
        } else if (withinDue && isActive && baseFee > 0 && m >= joinMonth) {
          // No manual record and the month is on/after the joining month → auto-bill.
          periodReceivable += baseFee
          periodDue += baseFee
          autoMonths.push(m)
        }
      }
      return { baseFee, studentCells, periodDue, periodCollected, periodReceivable, autoMonths }
    }

    // Summary across the entire filtered set (not just the page).
    let sumDue = 0, sumCollected = 0, sumReceivable = 0
    for (const s of allStudents) {
      const c = computeStudent(s)
      sumDue += c.periodDue; sumCollected += c.periodCollected; sumReceivable += c.periodReceivable
    }

    const records = pageStudents.map(s => {
      const c = computeStudent(s)
      return {
        _id: s._id,
        name: s.name,
        rollNo: s.rollNo,
        status: s.status,
        baseFee: c.baseFee,
        currency: s.billing?.currency || 'PKR',
        cycle: s.billing?.cycle || 'monthly', // unset → monthly (schema default)
        familyId: s.familyId?._id || null,
        familyCode: s.familyId?.familyCode || '',
        months: c.studentCells,
        autoMonths: c.autoMonths,
        dueTillDate: c.periodDue, // outstanding within the selected period
      }
    })

    res.json({
      year,
      records,
      total,
      page,
      pages: showAll ? 1 : Math.max(1, Math.ceil(total / limit)),
      summary: {
        students: total,
        collected: sumCollected,
        due: sumDue,
        receivable: sumReceivable,
        cycleCounts,
        fromMonth, toMonth, currentMonth: nowMonth, currentYear: nowYear,
      },
    })
  } catch (err) {
    console.error('Fee grid error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// PATCH /portal/fees/cell — set a single month's status/amount directly
export async function upsertFeeCell(req, res) {
  try {
    const { studentId, year, month, amount, amountPaid, status, note, currency } = req.body
    if (!studentId || !year || !month) return res.status(400).json({ error: 'studentId, year and month are required' })

    const student = await Student.findById(studentId).select('familyId').lean()
    if (!student) return res.status(404).json({ error: 'Student not found' })

    const rec = await StudentFeeRecord.findOne({ studentId, year, month: clampMonth(month) })
      || new StudentFeeRecord({ studentId, year, month: clampMonth(month), familyId: student.familyId })

    if (amount !== undefined) rec.amount = Math.max(0, Number(amount) || 0)
    if (amountPaid !== undefined) rec.amountPaid = Math.max(0, Number(amountPaid) || 0)
    if (currency !== undefined) rec.currency = currency
    if (note !== undefined) rec.note = note
    if (status !== undefined) {
      rec.status = status // explicit override (e.g. 'waived')
    } else {
      rec.status = computeStatus(rec)
    }
    if (rec.status === 'received' && !rec.paidAt) rec.paidAt = new Date()
    if (!rec.familyId) rec.familyId = student.familyId
    rec.recordedBy = req.userId

    await rec.save()
    res.json(rec)
  } catch (err) {
    console.error('Fee cell upsert error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// PATCH /portal/fees/receivables — set the expected (receivable) amount for a
// student across many months at once. Leaves amountPaid untouched; recomputing
// status keeps it in sync with the Yearly Grid (amount>0 & unpaid → pending).
export async function bulkUpsertReceivables(req, res) {
  try {
    const { studentId, year, months, amount, overwrite } = req.body
    if (!studentId || !year || !Array.isArray(months) || months.length === 0) {
      return res.status(400).json({ error: 'studentId, year and months[] are required' })
    }
    const amt = Math.max(0, Number(amount) || 0)
    const student = await Student.findById(studentId).select('familyId billing.currency').lean()
    if (!student) return res.status(404).json({ error: 'Student not found' })

    for (const rawMonth of months) {
      const month = clampMonth(rawMonth)
      let rec = await StudentFeeRecord.findOne({ studentId, year, month })
      if (!rec) {
        rec = new StudentFeeRecord({ studentId, year, month, familyId: student.familyId, currency: student.billing?.currency || 'PKR' })
      } else if (!overwrite && rec.amount > 0) {
        continue // don't clobber an existing receivable unless explicitly told to
      }
      rec.amount = amt
      if (rec.status !== 'waived') rec.status = computeStatus(rec)
      if (!rec.familyId) rec.familyId = student.familyId
      rec.recordedBy = req.userId
      await rec.save()
    }
    res.json({ ok: true, months: months.length })
  } catch (err) {
    console.error('Bulk receivables error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Apply a FeePayment's allocations to the corresponding month cells
async function applyAllocations(payment, userId) {
  for (const alloc of payment.allocations) {
    const student = await Student.findById(alloc.studentId).select('familyId').lean()
    const month = clampMonth(alloc.month)
    let rec = await StudentFeeRecord.findOne({ studentId: alloc.studentId, year: alloc.year, month })
    if (!rec) {
      rec = new StudentFeeRecord({ studentId: alloc.studentId, year: alloc.year, month, familyId: student?.familyId, currency: payment.currency })
    }
    rec.amountPaid = Math.max(0, (rec.amountPaid || 0) + (alloc.amount || 0))
    rec.currency = payment.currency
    rec.method = payment.method
    rec.paidAt = payment.paidAt
    rec.recordedBy = userId
    if (!rec.payments) rec.payments = []
    rec.payments.push(payment._id)
    if (!rec.familyId) rec.familyId = student?.familyId
    rec.status = computeStatus(rec)
    await rec.save()
  }
}

// POST /portal/fees/payments — record a manual payment across months/students
export async function createFeePayment(req, res) {
  try {
    const { amount, currency, method, reference, payerName, familyId, paidAt, linkedPaymentId, allocations, note } = req.body
    if (!amount || amount <= 0) return res.status(400).json({ error: 'A positive amount is required' })
    if (!Array.isArray(allocations) || allocations.length === 0) return res.status(400).json({ error: 'At least one allocation (student + month) is required' })

    const cleanAllocations = allocations
      .filter(a => a.studentId && a.month && a.year)
      .map(a => ({ studentId: a.studentId, year: parseInt(a.year, 10), month: clampMonth(a.month), amount: Math.max(0, Number(a.amount) || 0) }))
    if (cleanAllocations.length === 0) return res.status(400).json({ error: 'Allocations must include studentId, month and year' })

    // Prevent double-linking a gateway payment
    if (linkedPaymentId) {
      const existing = await FeePayment.findOne({ linkedPaymentId }).lean()
      if (existing) return res.status(400).json({ error: 'This gateway payment is already linked to a fee record' })
    }

    const payment = await FeePayment.create({
      amount: Number(amount),
      currency: currency || 'PKR',
      method: method || 'bank_transfer',
      reference: reference || '',
      payerName: payerName || '',
      familyId: familyId || undefined,
      paidAt: paidAt ? new Date(paidAt) : new Date(),
      linkedPaymentId: linkedPaymentId || undefined,
      allocations: cleanAllocations,
      note: note || '',
      recordedBy: req.userId,
    })

    await applyAllocations(payment, req.userId)

    await logActivity({
      level: 'info', category: 'finance', action: 'fee_payment_recorded',
      message: `Fee payment recorded: ${payment.currency} ${payment.amount} across ${cleanAllocations.length} month(s)`,
      req, meta: { feePaymentId: payment._id },
    })

    const populated = await FeePayment.findById(payment._id)
      .populate('allocations.studentId', 'name rollNo')
      .populate('familyId', 'familyCode')
      .lean()
    res.status(201).json(populated)
  } catch (err) {
    console.error('Create fee payment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/fees/payments — list recorded fee payments
export async function listFeePayments(req, res) {
  try {
    const { studentId, familyId, year, fromMonth, toMonth } = req.query
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25))

    const filter = {}
    if (familyId) filter.familyId = familyId
    // Scope to the selected period: a payment matches when it has an allocation in
    // this year (and month range, if given) — for the same student when filtered.
    const elem = {}
    if (year) {
      elem.year = parseInt(year, 10)
      const fm = Math.min(12, Math.max(1, parseInt(fromMonth, 10) || 1))
      const tm = Math.max(fm, Math.min(12, Math.max(1, parseInt(toMonth, 10) || 12)))
      elem.month = { $gte: fm, $lte: tm }
    }
    if (studentId) elem.studentId = studentId
    if (Object.keys(elem).length) filter.allocations = { $elemMatch: elem }

    const total = await FeePayment.countDocuments(filter)
    const records = await FeePayment.find(filter)
      .populate('allocations.studentId', 'name rollNo')
      .populate('familyId', 'familyCode')
      .populate('recordedBy', 'displayName')
      .populate('linkedPaymentId', 'studentName amount gatewayTransactionId')
      .sort({ paidAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()

    res.json({ records, total, page, pages: Math.max(1, Math.ceil(total / limit)) })
  } catch (err) {
    console.error('List fee payments error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// DELETE /portal/fees/payments/:id — remove a payment and roll back its cells
export async function deleteFeePayment(req, res) {
  try {
    const payment = await FeePayment.findById(req.params.id)
    if (!payment) return res.status(404).json({ error: 'Fee payment not found' })

    for (const alloc of payment.allocations) {
      const rec = await StudentFeeRecord.findOne({ studentId: alloc.studentId, year: alloc.year, month: clampMonth(alloc.month) })
      if (!rec) continue
      rec.amountPaid = Math.max(0, (rec.amountPaid || 0) - (alloc.amount || 0))
      rec.payments = (rec.payments || []).filter(p => p.toString() !== payment._id.toString())
      rec.status = computeStatus(rec)
      if (rec.status === 'pending') rec.paidAt = undefined
      await rec.save()
    }

    await FeePayment.deleteOne({ _id: payment._id })
    await logActivity({
      level: 'warning', category: 'finance', action: 'fee_payment_deleted',
      message: `Fee payment removed (${payment.currency} ${payment.amount})`,
      req, meta: { feePaymentId: payment._id },
    })
    res.json({ message: 'Fee payment removed and allocations rolled back' })
  } catch (err) {
    console.error('Delete fee payment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/fees/linkable-payments — completed gateway payments not yet linked
export async function listLinkablePayments(req, res) {
  try {
    const { search } = req.query
    const linked = await FeePayment.find({ linkedPaymentId: { $ne: null } }).distinct('linkedPaymentId')
    const filter = { status: 'completed', _id: { $nin: linked } }
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ studentName: rx }, { studentEmail: rx }, { invoiceNo: rx }]
    }
    const records = await Payment.find(filter)
      .select('studentName studentEmail amount currency createdAt gatewayTransactionId invoiceNo student')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()
    res.json({ records })
  } catch (err) {
    console.error('List linkable payments error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

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

// GET /portal/fees/grid — yearly grid of students × 12 months
export async function getFeeGrid(req, res) {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear()
    const { familyId, studentId, search, studentStatus } = req.query
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25))

    const filter = {}
    if (studentId) filter._id = studentId
    if (familyId) filter.familyId = familyId
    // Enrollment status filter: active (incl. on-leave, excl. left) | left | all
    if (studentStatus === 'left') filter.status = 'left'
    else if (studentStatus !== 'all') filter.status = { $ne: 'left' } // default: active-ish
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ name: rx }, { rollNo: rx }]
    }

    const total = await Student.countDocuments(filter)
    const students = await Student.find(filter)
      .select('name rollNo status familyId billing.fee billing.currency')
      .populate('familyId', 'familyCode primaryGuardian')
      .sort({ name: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()

    const ids = students.map(s => s._id)
    const cells = await StudentFeeRecord.find({ studentId: { $in: ids }, year }).lean()
    const byStudent = {}
    for (const c of cells) {
      const k = c.studentId.toString()
      if (!byStudent[k]) byStudent[k] = {}
      byStudent[k][c.month] = {
        status: c.status, amount: c.amount, amountPaid: c.amountPaid,
        currency: c.currency, note: c.note, method: c.method, paidAt: c.paidAt,
      }
    }

    const records = students.map(s => ({
      _id: s._id,
      name: s.name,
      rollNo: s.rollNo,
      status: s.status,
      baseFee: s.billing?.fee || 0,
      currency: s.billing?.currency || 'PKR',
      familyId: s.familyId?._id || null,
      familyCode: s.familyId?.familyCode || '',
      months: byStudent[s._id.toString()] || {},
    }))

    // Per-year totals across the returned page
    const received = cells.filter(c => c.status === 'received').length
    const partial = cells.filter(c => c.status === 'partial').length
    const totalCollected = cells.reduce((s, c) => s + (c.amountPaid || 0), 0)
    // Receivables view: total expected vs still outstanding
    const totalReceivable = cells.reduce((s, c) => s + (c.status === 'waived' ? 0 : c.amount || 0), 0)
    const outstanding = cells.reduce((s, c) => s + (c.status === 'waived' ? 0 : Math.max(0, (c.amount || 0) - (c.amountPaid || 0))), 0)

    res.json({
      year,
      records,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      summary: { received, partial, totalCollected, totalReceivable, outstanding },
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
    const { studentId, familyId, year } = req.query
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25))

    const filter = {}
    if (studentId) filter['allocations.studentId'] = studentId
    if (familyId) filter.familyId = familyId
    if (year) filter['allocations.year'] = parseInt(year, 10)

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

// Manual Fee Management — a yearly per-student grid of fee status, decoupled
// from the payment gateway (bank transfers / cash / mixed modes are recorded by
// hand). One FeePayment can be allocated across many months and many students
// (family relations), and can optionally wrap an existing gateway Payment.
import StudentFeeRecord from '../models/StudentFeeRecord.js'
import FeePayment from '../models/FeePayment.js'
import Student from '../models/Student.js'
import Family from '../models/Family.js'
import Payment from '../models/Payment.js'
// Imported for its side effect: registers the User model so `recordedBy` populates.
import '../models/User.js'
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

    const student = await Student.findById(studentId).select('familyId billing.currency').lean()
    if (!student) return res.status(404).json({ error: 'Student not found' })

    // A new cell inherits the student's agreed billing currency. Without this it
    // fell back to the schema default (PKR), so a student priced in USD or GBP
    // on their student detail page got a month recorded in rupees — and since
    // totals are grouped per currency and never converted, the ledger then
    // showed the wrong figure to the student and to the office.
    // (bulkUpsertReceivables already does this; this path was the gap.)
    const rec = await StudentFeeRecord.findOne({ studentId, year, month: clampMonth(month) })
      || new StudentFeeRecord({
        studentId,
        year,
        month: clampMonth(month),
        familyId: student.familyId,
        currency: student.billing?.currency || 'PKR',
      })

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

const cellKey = (a) => `${a.studentId}|${a.year}|${clampMonth(a.month)}`

// Sum a payment's allocations per month cell (one payment may list the same
// student + month twice).
function sumByCell(allocations = []) {
  const map = new Map()
  for (const a of allocations) {
    const k = cellKey(a)
    const cur = map.get(k) || { studentId: a.studentId, year: a.year, month: clampMonth(a.month), amount: 0 }
    cur.amount += a.amount || 0
    map.set(k, cur)
  }
  return map
}

// A cell that holds nothing — no fee, no money, no payment, no note. A payment
// logged against a month with no record creates one of these; left behind after
// that payment is edited away or removed, it would stop the month being
// auto-billed, so it is deleted instead (the month goes back to how it was).
const isEmptyCell = (rec) => !rec.amount && !rec.amountPaid && !(rec.payments || []).length
  && !rec.note && rec.status === 'pending'

/**
 * Move a payment's money between month cells. `before` is what the payment
 * allocated until now (empty for a new payment), `payment` is the payment as it
 * now stands (null when it is removed). Each cell moves by the DIFFERENCE only —
 * so a month the payment no longer covers loses exactly its share, a month it
 * still covers is untouched, and an amount typed into a cell by hand survives
 * an edit that didn't change that month.
 */
async function syncPaymentCells(paymentId, before, payment, userId) {
  const oldCells = sumByCell(before)
  const newCells = sumByCell(payment?.allocations)
  const keys = new Set([...oldCells.keys(), ...newCells.keys()])
  const pid = String(paymentId)

  for (const k of keys) {
    const was = oldCells.get(k)
    const now = newCells.get(k)
    const ref = now || was
    let rec = await StudentFeeRecord.findOne({ studentId: ref.studentId, year: ref.year, month: ref.month })
    if (!rec) {
      if (!now) continue // nothing to roll back
      const student = await Student.findById(ref.studentId).select('familyId').lean()
      rec = new StudentFeeRecord({ studentId: ref.studentId, year: ref.year, month: ref.month, familyId: student?.familyId, currency: payment.currency })
    }
    rec.amountPaid = Math.max(0, (rec.amountPaid || 0) - (was?.amount || 0) + (now?.amount || 0))
    const others = (rec.payments || []).filter(p => String(p) !== pid)
    if (now) {
      rec.payments = [...others, payment._id]
      rec.currency = payment.currency
      rec.method = payment.method
      rec.paidAt = payment.paidAt
    } else {
      // This payment no longer touches the month: the method / date shown on the
      // cell come from the latest payment still on it, or are cleared.
      rec.payments = others
      const latest = others.length
        ? await FeePayment.findOne({ _id: { $in: others } }).sort({ paidAt: -1 }).select('method paidAt').lean()
        : null
      rec.method = latest?.method || ''
      rec.paidAt = latest?.paidAt || (rec.amountPaid > 0 ? rec.paidAt : undefined)
    }
    rec.recordedBy = userId
    if (!rec.familyId) {
      const student = await Student.findById(ref.studentId).select('familyId').lean()
      rec.familyId = student?.familyId
    }
    rec.status = computeStatus(rec)
    if (rec.status === 'pending' && !rec.amountPaid) rec.paidAt = undefined

    if (!rec.isNew && isEmptyCell(rec)) await StudentFeeRecord.deleteOne({ _id: rec._id })
    else await rec.save()
  }
}

// Shared by create and edit: validate the body into clean allocations.
function cleanAllocationsFrom(allocations) {
  if (!Array.isArray(allocations)) return []
  return allocations
    .filter(a => a.studentId && a.month && a.year)
    .map(a => ({ studentId: a.studentId, year: parseInt(a.year, 10), month: clampMonth(a.month), amount: Math.max(0, Number(a.amount) || 0) }))
}

const populatePayment = (id) => FeePayment.findById(id)
  .populate('allocations.studentId', 'name rollNo')
  .populate('familyId', 'familyCode')
  .populate('recordedBy', 'displayName')
  .populate('linkedPaymentId', 'studentName amount gatewayTransactionId')
  .lean()

// POST /portal/fees/payments — record a manual payment across months/students
export async function createFeePayment(req, res) {
  try {
    const { amount, currency, method, reference, payerName, familyId, paidAt, linkedPaymentId, allocations, note } = req.body
    if (!amount || amount <= 0) return res.status(400).json({ error: 'A positive amount is required' })
    if (!Array.isArray(allocations) || allocations.length === 0) return res.status(400).json({ error: 'At least one allocation (student + month) is required' })

    const cleanAllocations = cleanAllocationsFrom(allocations)
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

    await syncPaymentCells(payment._id, [], payment, req.userId)

    await logActivity({
      level: 'info', category: 'finance', action: 'fee_payment_recorded',
      message: `Fee payment recorded: ${payment.currency} ${payment.amount} across ${cleanAllocations.length} month(s)`,
      req, meta: { feePaymentId: payment._id },
    })

    res.status(201).json(await populatePayment(payment._id))
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

// PUT /portal/fees/payments/:id — edit a recorded payment in place. The SAME
// payment is changed (never a second one added), and every month it covered
// before or covers now is moved by the difference — so a month taken off the
// payment stops showing it as paid, in the grid, the payments log, the student's
// history and the Fee Tracker alike.
export async function updateFeePayment(req, res) {
  try {
    const current = await FeePayment.findById(req.params.id).lean()
    if (!current) return res.status(404).json({ error: 'Fee payment not found' })

    const { amount, currency, method, reference, payerName, paidAt, linkedPaymentId, allocations, note } = req.body
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'A positive amount is required' })
    const cleanAllocations = cleanAllocationsFrom(allocations)
    if (cleanAllocations.length === 0) return res.status(400).json({ error: 'At least one allocation (student + month) is required' })
    if (currency !== undefined && !FeePayment.schema.path('currency').enumValues.includes(currency)) {
      return res.status(400).json({ error: 'Unknown currency' })
    }
    if (method !== undefined && !FeePayment.schema.path('method').enumValues.includes(method)) {
      return res.status(400).json({ error: 'Unknown payment method' })
    }
    let paidAtDate
    if (paidAt) {
      paidAtDate = new Date(paidAt)
      if (isNaN(paidAtDate.getTime())) return res.status(400).json({ error: 'Invalid payment date' })
    }

    const set = { amount: Number(amount), allocations: cleanAllocations }
    if (currency !== undefined) set.currency = currency
    if (method !== undefined) set.method = method
    if (reference !== undefined) set.reference = String(reference || '').trim()
    if (payerName !== undefined) set.payerName = String(payerName || '').trim()
    if (note !== undefined) set.note = String(note || '').trim()
    if (paidAtDate) set.paidAt = paidAtDate
    const unset = {}
    if (linkedPaymentId !== undefined && String(linkedPaymentId || '') !== String(current.linkedPaymentId || '')) {
      if (linkedPaymentId) {
        const taken = await FeePayment.findOne({ linkedPaymentId, _id: { $ne: current._id } }).lean()
        if (taken) return res.status(400).json({ error: 'This gateway payment is already linked to a fee record' })
        set.linkedPaymentId = linkedPaymentId
      } else {
        unset.linkedPaymentId = 1
      }
    }

    // Claim the edit against the version that was read: a double-click or two
    // people saving at once can't both roll the old months back (which would
    // take the money off twice and add it on twice).
    const update = { $set: set, $inc: { __v: 1 } }
    if (Object.keys(unset).length) update.$unset = unset
    const before = await FeePayment.findOneAndUpdate(
      { _id: current._id, __v: current.__v ?? { $exists: false } }, update, { new: false, runValidators: true },
    ).lean()
    if (!before) return res.status(409).json({ error: 'This payment was just changed by someone else. Reload and try again.' })

    const payment = await FeePayment.findById(current._id).lean()
    await syncPaymentCells(payment._id, before.allocations, payment, req.userId)

    await logActivity({
      level: 'info', category: 'finance', action: 'fee_payment_updated',
      message: `Fee payment edited: ${before.currency} ${before.amount} (${before.allocations.length} month(s)) → ${payment.currency} ${payment.amount} (${payment.allocations.length} month(s))`,
      req, meta: { feePaymentId: payment._id },
    })
    res.json(await populatePayment(payment._id))
  } catch (err) {
    console.error('Update fee payment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// DELETE /portal/fees/payments/:id — remove a payment and roll back its cells
export async function deleteFeePayment(req, res) {
  try {
    // Delete first, then roll back from the deleted copy: a second request for
    // the same payment finds nothing, so the months are never rolled back twice.
    const payment = await FeePayment.findOneAndDelete({ _id: req.params.id }).lean()
    if (!payment) return res.status(404).json({ error: 'Fee payment not found' })

    await syncPaymentCells(payment._id, payment.allocations, null, req.userId)

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

// ─── Student fee history (one student's complete ledger) ───

// "Today" in Asia/Karachi — the academy's billing clock, same boundary the grid uses.
function karachiNow() {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return { year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)) }
}

// Walks every month from the student's joining month up to the current month,
// merging saved StudentFeeRecord cells with the auto-billed base fee for months
// that were never recorded — the exact rule getFeeGrid applies, so the history
// can never disagree with the yearly grid. Returns null if the student is gone.
//
// Shared by the staff "Student History" tab and the student's own My Fees page.
async function buildStudentFeeHistory(studentId) {
  const student = await Student.findById(studentId)
    .select('name rollNo status familyId billing joiningDate createdAt')
    .populate('familyId', 'familyCode primaryGuardian')
    .lean()
  if (!student) return null

  const [cells, payments] = await Promise.all([
    StudentFeeRecord.find({ studentId }).lean(),
    FeePayment.find({ 'allocations.studentId': studentId })
      .populate('recordedBy', 'displayName')
      .populate('familyId', 'familyCode')
      .populate('linkedPaymentId', 'studentName amount currency gatewayTransactionId invoiceNo')
      .sort({ paidAt: -1 })
      .lean(),
  ])

  const now = karachiNow()
  const baseFee = student.billing?.fee || 0
  const currency = student.billing?.currency || 'PKR'
  const autoBillable = student.status !== 'left' && baseFee > 0

  // Window start: the joining month, or the earliest recorded cell if that's older.
  const jd = student.joiningDate || student.createdAt
  const j = jd ? new Date(jd) : null
  let startYear = j && !isNaN(j.getTime()) ? j.getUTCFullYear() : now.year
  let startMonth = j && !isNaN(j.getTime()) ? j.getUTCMonth() + 1 : 1
  for (const c of cells) {
    if (c.year < startYear || (c.year === startYear && c.month < startMonth)) {
      startYear = c.year; startMonth = c.month
    }
  }
  // Window end: the current month, or a later month already paid in advance.
  let endYear = now.year, endMonth = now.month
  for (const c of cells) {
    if (c.year > endYear || (c.year === endYear && c.month > endMonth)) {
      endYear = c.year; endMonth = c.month
    }
  }

  const cellMap = new Map(cells.map(c => [`${c.year}-${c.month}`, c]))

  // Payments that touched a given month, with the slice allocated to this student.
  const paymentsForMonth = (year, month) => payments
    .filter(p => (p.allocations || []).some(a =>
      String(a.studentId) === String(studentId) && a.year === year && a.month === month))
    .map(p => ({
      _id: p._id,
      amount: (p.allocations || [])
        .filter(a => String(a.studentId) === String(studentId) && a.year === year && a.month === month)
        .reduce((sum, a) => sum + (a.amount || 0), 0),
      currency: p.currency,
      method: p.method,
      reference: p.reference || '',
      payerName: p.payerName || '',
      paidAt: p.paidAt,
    }))

  const months = []
  let y = startYear, m = startMonth
  let guard = 0
  while ((y < endYear || (y === endYear && m <= endMonth)) && guard++ < 600) {
    const cell = cellMap.get(`${y}-${m}`)
    const isDueYet = y < now.year || (y === now.year && m <= now.month)
    if (cell) {
      months.push({
        year: y, month: m,
        amount: cell.amount || 0,
        amountPaid: cell.amountPaid || 0,
        currency: cell.currency || currency,
        status: cell.status,
        method: cell.method || '',
        note: cell.note || '',
        paidAt: cell.paidAt || null,
        auto: false,
        payments: paymentsForMonth(y, m),
      })
    } else if (isDueYet && autoBillable) {
      // No manual record and the month is on/after joining → auto-billed as pending.
      months.push({
        year: y, month: m,
        amount: baseFee,
        amountPaid: 0,
        currency,
        status: 'pending',
        method: '', note: '', paidAt: null,
        auto: true,
        payments: [],
      })
    }
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }

  months.sort((a, b) => (b.year - a.year) || (b.month - a.month))

  // Cells carry their own currency (a student can be re-priced from PKR to USD
  // mid-history), so totals are grouped per currency and never summed across.
  const byCurrency = new Map()
  for (const r of months) {
    if (r.status === 'waived') continue
    const c = r.currency || currency
    const t = byCurrency.get(c) || { currency: c, billed: 0, paid: 0, due: 0 }
    t.billed += r.amount || 0
    t.paid += r.amountPaid || 0
    t.due += Math.max(0, (r.amount || 0) - (r.amountPaid || 0))
    byCurrency.set(c, t)
  }
  const totalsByCurrency = [...byCurrency.values()]
    .filter(t => t.billed || t.paid || t.due)
    .sort((a, b) => (a.currency === currency ? -1 : b.currency === currency ? 1 : 0))
  // Headline figures = the student's own billing currency (falls back to the first
  // currency present when nothing was ever recorded in it).
  const totals = totalsByCurrency.find(t => t.currency === currency)
    || totalsByCurrency[0]
    || { currency, billed: 0, paid: 0, due: 0 }

  const currentMonth = months.find(r => r.year === now.year && r.month === now.month) || null

  return {
    student: {
      _id: student._id,
      name: student.name,
      rollNo: student.rollNo,
      status: student.status,
      baseFee,
      // The fee grid is kept in local PKR (`baseFee` is "Fee (local)"); what the
      // family is actually charged is `billing.amount` in `currency` ("Billed
      // amount" on the student detail page). The student app converts dues
      // with the ratio between the two.
      billedAmount: student.billing?.amount || 0,
      currency,
      cycle: student.billing?.cycle || 'monthly',
      familyCode: student.familyId?.familyCode || '',
    },
    months,
    payments: payments.map(p => ({
      _id: p._id,
      amount: p.amount,
      allocatedToStudent: (p.allocations || [])
        .filter(a => String(a.studentId) === String(studentId))
        .reduce((sum, a) => sum + (a.amount || 0), 0),
      currency: p.currency,
      method: p.method,
      reference: p.reference || '',
      payerName: p.payerName || '',
      note: p.note || '',
      paidAt: p.paidAt,
      familyCode: p.familyId?.familyCode || '',
      recordedBy: p.recordedBy?.displayName || '',
      gatewayRef: p.linkedPaymentId?.gatewayTransactionId || '',
      months: (p.allocations || [])
        .filter(a => String(a.studentId) === String(studentId))
        .map(a => ({ year: a.year, month: a.month, amount: a.amount || 0 })),
    })),
    totals,
    totalsByCurrency,
    current: currentMonth,
    now,
  }
}

// GET /portal/fees/student/:studentId/history — staff view (fee.read).
export async function getStudentFeeHistory(req, res) {
  try {
    const data = await buildStudentFeeHistory(req.params.studentId)
    if (!data) return res.status(404).json({ error: 'Student not found' })
    res.json(data)
  } catch (err) {
    console.error('Student fee history error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/fees/my — the logged-in student's own ledger. Deliberately NOT
// gated by fee.read (students hold no finance permissions); the account's
// linkedStudentId IS the authorization, so no id can be passed in.
export async function getMyFees(req, res) {
  try {
    if (!req.user.linkedStudentId) {
      return res.status(403).json({ error: 'Your account is not linked to a student record' })
    }
    const data = await buildStudentFeeHistory(req.user.linkedStudentId)
    if (!data) return res.status(404).json({ error: 'Student not found' })
    res.json(data)
  } catch (err) {
    console.error('My fees error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

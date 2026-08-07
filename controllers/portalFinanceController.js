import Invoice from '../models/Invoice.js'
import SalaryRecord from '../models/SalaryRecord.js'
import SalaryIncrement from '../models/SalaryIncrement.js'
import TutorAttendance from '../models/TutorAttendance.js'
import TutorProfile from '../models/TutorProfile.js'
import StaffProfile from '../models/StaffProfile.js'
import Advance from '../models/Advance.js'
import ShiftConfig from '../models/ShiftConfig.js'
import Student from '../models/Student.js'
import User from '../models/User.js'
import { logActivity } from '../utils/activityLogger.js'
import { createNotification } from './portalNotificationController.js'

// Resolve the portal user linked to a student / tutor profile (null-safe)
async function studentUser(studentId) {
  const s = await Student.findById(studentId).select('userId name').lean()
  return s?.userId ? { userId: s.userId, name: s.name } : null
}
async function tutorUser(tutorId) {
  const u = await User.findOne({ linkedTutorId: tutorId, status: 'active' }).select('_id').lean()
  return u ? { userId: u._id } : null
}

// Active management/staff users on payroll: not linked to a tutor or student
// profile, and holding at least one non-student role. These are the salary/
// attendance subjects for the "Staff" scope (super_admin employs them too).
async function getStaffSubjects() {
  const users = await User.find({
    status: 'active',
    linkedTutorId: { $in: [null, undefined] },
    linkedStudentId: { $in: [null, undefined] },
  }).populate('roles', 'key').select('displayName email roles').lean()

  // Exclude anyone who actually OWNS a tutor profile — they belong in the Tutor
  // scope, not Staff. Catches placeholder/system accounts (e.g. the import
  // "Unassigned Tutor", which has a tutor role + TutorProfile but no linkedTutorId)
  // and real tutors whose linkedTutorId was never backfilled.
  const tutorOwners = await TutorProfile.find({ userId: { $in: users.map(u => u._id) } }).select('userId').lean()
  const tutorUserIds = new Set(tutorOwners.map(t => String(t.userId)))

  // On payroll: has a non-student role, and is not a super_admin (the boss pays
  // staff, they aren't a payroll subject themselves).
  return users.filter(u => {
    if (tutorUserIds.has(String(u._id))) return false
    const keys = (u.roles || []).map(r => r.key)
    return keys.some(k => k !== 'student') && !keys.includes('super_admin')
  })
}

// Net payable for the user-managed salary sheet:
//   Monthly + Extra Classes + Extra Money − Fine − Advance Received
// Absentees is informational only (absent-day count) and is NOT deducted.
function computeSalaryNet(r) {
  return (Number(r.baseAmount) || 0)
    + (Number(r.extraClassesAmount) || 0)
    + (Number(r.extraMoney) || 0)
    - (Number(r.fine) || 0)
    - (Number(r.advanceDeductions) || 0)
}

// The editable money fields on a salary row (all optional in the request body).
// absenteesDeduction is intentionally excluded — absentees no longer affect pay.
const SALARY_MONEY_FIELDS = ['baseAmount', 'fine', 'extraClassesAmount', 'extraMoney', 'advanceDeductions']

// ─── Invoices ───

async function generateInvoiceNo() {
  const count = await Invoice.countDocuments()
  return `INV-${String(count + 1).padStart(5, '0')}`
}

export async function listInvoices(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { studentId, status, search, sort } = req.query

    const filter = {}
    if (studentId) filter.studentId = studentId
    if (status) filter.status = status
    if (search) {
      const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.invoiceNo = regex
    }

    const total = await Invoice.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    let sortObj = { createdAt: -1 }
    if (sort === 'dueDate') sortObj = { dueDate: 1 }
    if (sort === '-amount') sortObj = { amount: -1 }
    if (sort === 'status') sortObj = { status: 1, createdAt: -1 }

    const records = await Invoice.find(filter)
      .populate('studentId', 'name rollNo')
      .populate('createdBy', 'displayName')
      .sort(sortObj)
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    // Stats
    const stats = await Invoice.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$amount' } } },
    ])

    res.json({ records, total, page: safePage, pages, stats })
  } catch (err) {
    console.error('List invoices error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createInvoice(req, res) {
  try {
    const { studentId, items, currency, dueDate, notes } = req.body
    if (!studentId || !items?.length) return res.status(400).json({ error: 'studentId and items are required' })

    const amount = items.reduce((sum, it) => sum + (it.amount * (it.quantity || 1)), 0)
    const invoiceNo = await generateInvoiceNo()

    const invoice = await Invoice.create({
      invoiceNo, studentId, items, amount,
      currency: currency || 'PKR',
      dueDate: dueDate ? new Date(dueDate) : undefined,
      notes: notes || '',
      createdBy: req.userId,
    })

    await logActivity({ level: 'info', category: 'finance', action: 'invoice_created', message: `Invoice ${invoiceNo} created`, req })

    const su = await studentUser(studentId)
    if (su) {
      await createNotification({
        userId: su.userId,
        type: 'invoice_created',
        title: 'New Invoice',
        body: `Invoice ${invoiceNo} (${currency || 'PKR'} ${amount.toLocaleString()}) has been issued to you.`,
        payload: { invoiceId: invoice._id, invoiceNo },
      })
    }

    const populated = await Invoice.findById(invoice._id).populate('studentId', 'name rollNo').lean()
    res.status(201).json(populated)
  } catch (err) {
    console.error('Create invoice error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateInvoiceStatus(req, res) {
  try {
    const invoice = await Invoice.findById(req.params.id)
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })

    const { status, paidAmount } = req.body
    const wasPaid = invoice.status === 'paid'
    if (status) invoice.status = status
    if (paidAmount !== undefined) invoice.paidAmount = paidAmount
    await invoice.save()

    if (!wasPaid && invoice.status === 'paid') {
      const su = await studentUser(invoice.studentId)
      if (su) {
        await createNotification({
          userId: su.userId,
          type: 'invoice_paid',
          title: 'Payment Received',
          body: `Invoice ${invoice.invoiceNo} has been marked as paid. JazakAllah Khair!`,
          payload: { invoiceId: invoice._id, invoiceNo: invoice.invoiceNo },
        })
      }
    }

    res.json(invoice)
  } catch (err) {
    console.error('Update invoice error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteInvoice(req, res) {
  try {
    const invoice = await Invoice.findById(req.params.id)
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })

    await invoice.deleteOne()

    await logActivity({ level: 'warn', category: 'finance', action: 'invoice_deleted', message: `Invoice ${invoice.invoiceNo} deleted`, req })

    res.json({ success: true, id: invoice._id })
  } catch (err) {
    console.error('Delete invoice error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Salary Records ───

export async function listSalaryRecords(req, res) {
  try {
    const { tutorId, userId, month, year } = req.query
    const filter = {}
    if (tutorId) filter.tutorId = tutorId
    if (userId) filter.userId = userId
    if (month) filter.month = Number(month)
    if (year) filter.year = Number(year)

    const query = () => SalaryRecord.find(filter)
      .populate('tutorId', 'name tutorId salary')
      .populate('userId', 'displayName email')
      .sort({ year: -1, month: -1 })

    // Legacy callers (no ?page) get a flat array; paginated callers get an envelope
    if (!req.query.page) {
      const records = await query().limit(500).lean()
      return res.json(records)
    }

    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const total = await SalaryRecord.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)
    const records = await query().skip((safePage - 1) * lim).limit(lim).lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List salary records error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Suggest a default advance deduction for the month from the tutor's active advances
// (does NOT mutate the advance — the amount is only posted to the ledger when the salary is paid).
async function suggestAdvanceDeduction(tutorId) {
  const activeAdvances = await Advance.find({ tutorId, status: 'active' }).lean()
  let suggested = 0
  for (const adv of activeAdvances) {
    if (adv.installmentFrequency === 'monthly') {
      suggested += Math.min(adv.installmentAmount || 0, adv.remainingBalance || 0)
    }
  }
  return suggested
}

export async function generateSalary(req, res) {
  try {
    const { tutorId, userId, month, year } = req.body
    const num = (v, fallback = 0) => (v === undefined || v === null || v === '' ? fallback : Number(v))

    // ── Custom / off-portal person (guard, sweeper, IT, off-portal manager, …) ──
    // Identified by a free-text name — no tutor/user account. Created directly
    // (no attendance, no advance ledger, no notification).
    const isCustom = req.body.subjectType === 'custom' || (!tutorId && !userId && !!(req.body.personName || '').trim())
    if (isCustom) {
      const personName = (req.body.personName || '').trim()
      if (!personName || !month || !year) return res.status(400).json({ error: 'personName, month, and year are required' })
      const currency = ['PKR', 'USD', 'EUR', 'GBP', 'CAD'].includes(req.body.currency) ? req.body.currency : 'PKR'
      const draft = {
        subjectType: 'custom', personName, personRole: (req.body.personRole || '').trim(),
        month: Number(month), year: Number(year), currency,
        baseAmount: num(req.body.baseAmount),
        absenteesDeduction: 0,
        fine: num(req.body.fine),
        extraClassesAmount: num(req.body.extraClassesAmount),
        extraMoney: num(req.body.extraMoney),
        advanceDeductions: num(req.body.advanceDeductions),
        comment: (req.body.comment || '').trim(),
        status: ['draft', 'finalized'].includes(req.body.status) ? req.body.status : 'draft',
        generatedBy: req.userId,
      }
      draft.netPayable = computeSalaryNet(draft)
      draft.totalDeductions = (draft.fine || 0) + (draft.advanceDeductions || 0)
      draft.bonuses = (draft.extraClassesAmount || 0) + (draft.extraMoney || 0)
      const record = await SalaryRecord.create(draft)
      await logActivity({ level: 'info', category: 'salary', action: 'salary_generated', message: `Salary generated for ${personName} (custom, ${month}/${year})`, req })
      return res.status(201).json(record)
    }

    if ((!tutorId && !userId) || !month || !year) return res.status(400).json({ error: 'tutorId or userId, month, and year are required' })

    const isStaff = !!userId && !tutorId
    const subjectFilter = isStaff ? { userId } : { tutorId }

    const existing = await SalaryRecord.findOne({ ...subjectFilter, month, year })
    if (existing) return res.status(400).json({ error: 'Salary record already exists for this period' })

    // Resolve the subject + its default base pay / currency / label.
    let defaultBase = 0, defaultCurrency = 'PKR', subjectLabel = ''
    if (isStaff) {
      const user = await User.findById(userId).select('displayName email').lean()
      if (!user) return res.status(404).json({ error: 'Staff user not found' })
      const profile = await StaffProfile.findOne({ userId }).lean()
      defaultBase = profile?.baseSalary || 0
      defaultCurrency = profile?.salaryCurrency || 'PKR'
      subjectLabel = user.displayName || user.email
    } else {
      const tutor = await TutorProfile.findById(tutorId).lean()
      if (!tutor) return res.status(404).json({ error: 'Tutor not found' })
      defaultBase = tutor.salary?.baseAmount || 0
      defaultCurrency = tutor.salary?.currency || 'PKR'
      subjectLabel = tutor.tutorId
    }

    const startDate = new Date(year, month - 1, 1)
    const endDate = new Date(year, month, 0, 23, 59, 59)

    const attendance = await TutorAttendance.find({
      ...subjectFilter, date: { $gte: startDate, $lte: endDate },
    }).lean()

    const presentDays = attendance.filter(a => a.status === 'present').length
    const absentDays = attendance.filter(a => a.status === 'absent').length
    const totalHours = attendance.reduce((sum, a) => sum + (a.totalHours || 0), 0)

    const currency = req.body.currency || defaultCurrency

    // Advance ledger is tutor-only; staff advanceDeductions is a plain manual number.
    const advanceDeductions = num(req.body.advanceDeductions, isStaff ? 0 : await suggestAdvanceDeduction(tutorId))
    const draft = {
      ...subjectFilter, subjectType: isStaff ? 'staff' : 'tutor',
      month, year, currency,
      baseAmount: num(req.body.baseAmount, defaultBase),
      absenteesDeduction: 0, // informational only — absentDays is shown; no deduction
      fine: num(req.body.fine),
      extraClassesAmount: num(req.body.extraClassesAmount),
      extraMoney: num(req.body.extraMoney),
      advanceDeductions,
      comment: (req.body.comment || '').trim(),
      presentDays, absentDays, totalHours,
      status: ['draft', 'finalized'].includes(req.body.status) ? req.body.status : 'draft',
      generatedBy: req.userId,
    }
    draft.netPayable = computeSalaryNet(draft)
    // Keep legacy aggregate fields consistent for older readers / PDFs.
    draft.totalDeductions = (draft.fine || 0) + (draft.advanceDeductions || 0)
    draft.bonuses = (draft.extraClassesAmount || 0) + (draft.extraMoney || 0)

    const record = await SalaryRecord.create(draft)

    await logActivity({ level: 'info', category: 'salary', action: 'salary_generated', message: `Salary generated for ${subjectLabel} (${month}/${year})`, req })

    const notifyUserId = isStaff ? userId : (await tutorUser(tutorId))?.userId
    if (notifyUserId) {
      await createNotification({
        userId: notifyUserId,
        type: 'salary_generated',
        title: 'Salary Generated',
        body: `Your salary for ${month}/${year} has been generated (${currency} ${record.netPayable?.toLocaleString?.() || record.netPayable}).`,
        payload: { salaryRecordId: record._id, month, year },
      })
    }

    res.status(201).json(record)
  } catch (err) {
    console.error('Generate salary error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Post the salary's advance deduction against the tutor's active advances (oldest first).
// Idempotent via record.advanceRepaymentApplied.
async function applyAdvanceRepayment(record, req) {
  if (record.advanceRepaymentApplied) return
  let remaining = Number(record.advanceDeductions) || 0
  if (remaining <= 0) { record.advanceRepaymentApplied = true; return }
  const active = await Advance.find({ tutorId: record.tutorId, status: 'active' }).sort({ startDate: 1 })
  for (const adv of active) {
    if (remaining <= 0) break
    const pay = Math.min(remaining, adv.remainingBalance)
    if (pay <= 0) continue
    adv.installments.push({ date: new Date(), amount: pay, salaryRecordId: record._id, note: `Deducted in salary ${record.month}/${record.year}` })
    adv.amountRepaid += pay
    await adv.save() // pre-save recomputes balance / flips to fully_paid
    remaining -= pay
  }
  record.advanceRepaymentApplied = true
}

export async function updateSalaryStatus(req, res) {
  try {
    const record = await SalaryRecord.findById(req.params.id)
    if (!record) return res.status(404).json({ error: 'Record not found' })

    // Paid rows are locked — no field or status edits.
    if (record.status === 'paid') {
      return res.status(400).json({ error: 'This salary is marked paid and can no longer be edited' })
    }

    const { status, notes, comment } = req.body

    // Editable money fields (full user control before payment)
    for (const f of SALARY_MONEY_FIELDS) {
      if (req.body[f] !== undefined && req.body[f] !== null && req.body[f] !== '') {
        record[f] = Number(req.body[f])
      }
    }
    if (comment !== undefined) record.comment = comment
    if (notes !== undefined) record.notes = notes

    // Recompute net + legacy aggregates from the explicit columns
    record.netPayable = computeSalaryNet(record)
    record.totalDeductions = (record.fine || 0) + (record.advanceDeductions || 0)
    record.bonuses = (record.extraClassesAmount || 0) + (record.extraMoney || 0)

    const nowPaid = status === 'paid' && record.status !== 'paid'
    if (status && ['draft', 'finalized', 'paid'].includes(status)) {
      record.status = status
      if (nowPaid) {
        record.paidAt = new Date()
        const count = await SalaryRecord.countDocuments({ receiptNo: { $ne: '' } })
        record.receiptNo = `SR-${String(count + 1).padStart(5, '0')}`
        // Post the advance deduction to the tutor's advance ledger on payment.
        // Staff have no advance ledger — the deduction is just a plain number.
        if (record.subjectType !== 'staff' && record.tutorId) await applyAdvanceRepayment(record, req)
      }
    }

    await record.save()

    if (nowPaid) {
      const notifyUserId = record.subjectType === 'staff' ? record.userId : (await tutorUser(record.tutorId))?.userId
      if (notifyUserId) {
        await createNotification({
          userId: notifyUserId,
          type: 'salary_paid',
          title: 'Salary Paid',
          body: `Your salary for ${record.month}/${record.year} has been paid (receipt ${record.receiptNo || '—'}).`,
          payload: { salaryRecordId: record._id, receiptNo: record.receiptNo },
        })
      }
    }

    await logActivity({ level: 'info', category: 'salary', action: 'salary_updated', message: `Salary ${record._id} updated (${record.status})`, req })

    res.json(record)
  } catch (err) {
    console.error('Update salary error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getSalaryReceipt(req, res) {
  try {
    const record = await SalaryRecord.findById(req.params.id)
      .populate('tutorId', 'name tutorId salary')
      .populate('userId', 'displayName email')
      .populate('generatedBy', 'displayName')
      .lean()

    if (!record) return res.status(404).json({ error: 'Record not found' })

    res.json(record)
  } catch (err) {
    console.error('Get salary receipt error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Salary Increments ───

export async function listSalaryIncrements(req, res) {
  try {
    const filter = {}
    if (req.query.tutorId) filter.tutorId = req.query.tutorId

    const query = () => SalaryIncrement.find(filter)
      .populate('tutorId', 'name tutorId salary')
      .populate('approvedBy', 'displayName')
      .sort({ effectiveDate: -1 })

    // Legacy callers (no ?page) get a flat array; paginated callers get an envelope
    if (!req.query.page) {
      const records = await query().limit(500).lean()
      return res.json(records)
    }

    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const total = await SalaryIncrement.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)
    const records = await query().skip((safePage - 1) * lim).limit(lim).lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List salary increments error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createSalaryIncrement(req, res) {
  try {
    const { tutorId, newAmount, effectiveDate, reason } = req.body
    if (!tutorId || newAmount === undefined || !effectiveDate) {
      return res.status(400).json({ error: 'tutorId, newAmount, and effectiveDate are required' })
    }

    const tutor = await TutorProfile.findById(tutorId)
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' })

    const previousAmount = tutor.salary?.baseAmount || 0
    const incrementAmount = newAmount - previousAmount
    const incrementPercentage = previousAmount > 0
      ? Math.round((incrementAmount / previousAmount) * 10000) / 100
      : 0
    const currency = tutor.salary?.currency || 'PKR'

    const increment = await SalaryIncrement.create({
      tutorId,
      previousAmount,
      newAmount,
      incrementAmount,
      incrementPercentage,
      currency,
      effectiveDate: new Date(effectiveDate),
      reason: reason || '',
      approvedBy: req.userId,
    })

    // Update tutor's base salary
    tutor.salary.baseAmount = newAmount
    await tutor.save()

    await logActivity({
      level: 'info', category: 'salary', action: 'salary_increment',
      message: `Salary increment for ${tutor.tutorId}: ${currency} ${previousAmount} → ${newAmount} (${incrementPercentage > 0 ? '+' : ''}${incrementPercentage}%)`,
      req,
    })

    const populated = await SalaryIncrement.findById(increment._id)
      .populate('tutorId', 'name tutorId salary')
      .populate('approvedBy', 'displayName')
      .lean()

    const tu = await tutorUser(tutorId)
    if (tu) {
      await createNotification({
        userId: tu.userId,
        type: 'salary_increment',
        title: 'Salary Increment',
        body: `Your base salary has been updated: ${currency} ${previousAmount.toLocaleString()} → ${Number(newAmount).toLocaleString()} (effective ${new Date(effectiveDate).toLocaleDateString()}).`,
        payload: { incrementId: increment._id },
      })
    }

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create salary increment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getSalaryTimeline(req, res) {
  try {
    const { tutorId } = req.query
    if (!tutorId) return res.status(400).json({ error: 'tutorId is required' })

    const [salaryRecords, increments] = await Promise.all([
      SalaryRecord.find({ tutorId }).sort({ year: 1, month: 1 }).lean(),
      SalaryIncrement.find({ tutorId }).populate('approvedBy', 'displayName').sort({ effectiveDate: 1 }).lean(),
    ])

    // Build a unified timeline
    const timeline = [
      ...salaryRecords.map(r => ({
        type: 'salary',
        date: new Date(r.year, r.month - 1, 1).toISOString(),
        month: r.month,
        year: r.year,
        baseAmount: r.baseAmount,
        netPayable: r.netPayable,
        status: r.status,
        currency: r.currency,
      })),
      ...increments.map(inc => ({
        type: 'increment',
        date: inc.effectiveDate,
        previousAmount: inc.previousAmount,
        newAmount: inc.newAmount,
        incrementAmount: inc.incrementAmount,
        incrementPercentage: inc.incrementPercentage,
        reason: inc.reason,
        approvedBy: inc.approvedBy?.displayName || '',
        currency: inc.currency,
      })),
    ].sort((a, b) => new Date(a.date) - new Date(b.date))

    res.json({ timeline, salaryRecords, increments })
  } catch (err) {
    console.error('Salary timeline error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Payroll roster: every active tutor merged with their salary record for a period,
// plus their outstanding advance balance. Drives a payroll-run view.
// PATCH /portal/finance/staff/:userId/base — set a staff member's monthly base
// salary + currency (upserts their StaffProfile). Used as the default when
// generating their salary; editable per-month on the sheet afterwards.
export async function updateStaffBaseSalary(req, res) {
  try {
    const { userId } = req.params
    const user = await User.findById(userId).select('_id displayName').lean()
    if (!user) return res.status(404).json({ error: 'User not found' })

    const set = {}
    if (req.body.baseSalary !== undefined) set.baseSalary = Math.max(0, Number(req.body.baseSalary) || 0)
    if (req.body.salaryCurrency && ['PKR', 'USD', 'EUR', 'GBP', 'CAD'].includes(req.body.salaryCurrency)) {
      set.salaryCurrency = req.body.salaryCurrency
    }

    const profile = await StaffProfile.findOneAndUpdate(
      { userId },
      { $set: set, $setOnInsert: { userId } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean()

    await logActivity({ level: 'info', category: 'salary', action: 'staff_base_updated', message: `Staff base salary set for ${user.displayName}`, req })
    res.json(profile)
  } catch (err) {
    console.error('Update staff base salary error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getSalaryRoster(req, res) {
  try {
    const month = Number(req.query.month)
    const year = Number(req.query.year)
    if (!month || !year) return res.status(400).json({ error: 'month and year are required' })

    const scope = ['staff', 'custom'].includes(req.query.scope) ? req.query.scope : 'tutor'

    // ── Custom scope: off-portal people (guard, sweeper, IT, off-portal manager). ──
    // No pre-existing subject roster — the rows ARE the custom records for the period,
    // added on demand via generateSalary({ subjectType: 'custom', ... }).
    if (scope === 'custom') {
      const records = await SalaryRecord.find({ month, year, subjectType: 'custom' })
        .sort({ personName: 1 }).lean()
      const roster = records.map(r => ({
        subjectType: 'custom',
        personName: r.personName,
        personRole: r.personRole,
        currency: r.currency || 'PKR',
        outstandingAdvance: 0,
        record: r,
      }))
      return res.json({ roster, month, year, scope, total: records.length, generated: records.length, pending: 0 })
    }

    // ── Staff scope: management/staff users on payroll ──
    if (scope === 'staff') {
      const [subjects, records] = await Promise.all([
        getStaffSubjects(),
        SalaryRecord.find({ month, year, subjectType: 'staff' }).populate('userId', 'displayName email').lean(),
      ])
      const profiles = await StaffProfile.find({ userId: { $in: subjects.map(s => s._id) } }).lean()
      const profByUser = new Map(profiles.map(p => [String(p.userId), p]))
      const recByUser = new Map(records.map(r => [String(r.userId?._id || r.userId), r]))

      const roster = subjects
        .sort((a, b) => String(a.displayName || a.email).localeCompare(String(b.displayName || b.email)))
        .map(u => {
          const prof = profByUser.get(String(u._id))
          return {
            subjectType: 'staff',
            userId: { _id: u._id, displayName: u.displayName, email: u.email },
            baseAmount: prof?.baseSalary || 0,
            currency: prof?.salaryCurrency || 'PKR',
            outstandingAdvance: 0, // staff have no advance ledger
            record: recByUser.get(String(u._id)) || null,
          }
        })

      return res.json({ roster, month, year, scope, total: subjects.length, generated: records.length, pending: subjects.length - records.length })
    }

    // ── Tutor scope (default) ──
    const [tutors, records, activeAdvances] = await Promise.all([
      TutorProfile.find({ status: 'active' }).select('name tutorId salary').sort({ name: 1 }).lean(),
      SalaryRecord.find({ month, year, subjectType: { $nin: ['staff', 'custom'] } }).populate('tutorId', 'name tutorId').lean(),
      Advance.find({ status: 'active' }).select('tutorId remainingBalance currency').lean(),
    ])

    const recByTutor = new Map(records.map(r => [String(r.tutorId?._id || r.tutorId), r]))
    const advByTutor = new Map()
    for (const a of activeAdvances) {
      const k = String(a.tutorId)
      advByTutor.set(k, (advByTutor.get(k) || 0) + (a.remainingBalance || 0))
    }

    const roster = tutors.map(t => ({
      subjectType: 'tutor',
      tutorId: { _id: t._id, name: t.name, tutorId: t.tutorId },
      baseAmount: t.salary?.baseAmount || 0,
      currency: t.salary?.currency || 'PKR',
      outstandingAdvance: advByTutor.get(String(t._id)) || 0,
      record: recByTutor.get(String(t._id)) || null,
    }))

    res.json({
      roster,
      month,
      year,
      scope,
      total: tutors.length,
      generated: records.length,
      pending: tutors.length - records.length,
    })
  } catch (err) {
    console.error('Salary roster error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

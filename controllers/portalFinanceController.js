import Invoice from '../models/Invoice.js'
import SalaryRecord from '../models/SalaryRecord.js'
import SalaryIncrement from '../models/SalaryIncrement.js'
import TutorAttendance from '../models/TutorAttendance.js'
import TutorProfile from '../models/TutorProfile.js'
import Advance from '../models/Advance.js'
import ShiftConfig from '../models/ShiftConfig.js'
import { logActivity } from '../utils/activityLogger.js'

// ─── Invoices ───

async function generateInvoiceNo() {
  const count = await Invoice.countDocuments()
  return `INV-${String(count + 1).padStart(5, '0')}`
}

export async function listInvoices(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { studentId, status } = req.query

    const filter = {}
    if (studentId) filter.studentId = studentId
    if (status) filter.status = status

    const total = await Invoice.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1

    const records = await Invoice.find(filter)
      .populate('studentId', 'name rollNo')
      .populate('createdBy', 'displayName')
      .sort({ createdAt: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean()

    // Stats
    const stats = await Invoice.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$amount' } } },
    ])

    res.json({ records, total, page: pg, pages, stats })
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
    if (status) invoice.status = status
    if (paidAmount !== undefined) invoice.paidAmount = paidAmount
    await invoice.save()

    res.json(invoice)
  } catch (err) {
    console.error('Update invoice error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Salary Records ───

export async function listSalaryRecords(req, res) {
  try {
    const { tutorId, month, year } = req.query
    const filter = {}
    if (tutorId) filter.tutorId = tutorId
    if (month) filter.month = Number(month)
    if (year) filter.year = Number(year)

    const records = await SalaryRecord.find(filter)
      .populate('tutorId', 'name tutorId salary')
      .sort({ year: -1, month: -1 })
      .lean()

    res.json(records)
  } catch (err) {
    console.error('List salary records error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function generateSalary(req, res) {
  try {
    const { tutorId, month, year } = req.body
    if (!tutorId || !month || !year) return res.status(400).json({ error: 'tutorId, month, and year are required' })

    const existing = await SalaryRecord.findOne({ tutorId, month, year })
    if (existing) return res.status(400).json({ error: 'Salary record already exists for this period' })

    const tutor = await TutorProfile.findById(tutorId)
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' })

    const startDate = new Date(year, month - 1, 1)
    const endDate = new Date(year, month, 0, 23, 59, 59)

    const attendance = await TutorAttendance.find({
      tutorId, date: { $gte: startDate, $lte: endDate },
    }).lean()

    const presentDays = attendance.filter(a => a.status === 'present').length
    const absentDays = attendance.filter(a => a.status === 'absent').length
    const totalHours = attendance.reduce((sum, a) => sum + (a.totalHours || 0), 0)

    const baseAmount = tutor.salary?.baseAmount || 0
    const currency = tutor.salary?.currency || 'PKR'

    // Load shift config for overtime/bonus calculations
    const shiftConfig = await ShiftConfig.findOne({ key: 'default' }).lean()

    // Calculate deductions
    const deductions = []
    if (absentDays > 0) {
      const workingDays = presentDays + absentDays
      const perDayRate = workingDays > 0 ? baseAmount / workingDays : 0
      deductions.push({ reason: `Absent ${absentDays} day(s)`, amount: Math.round(perDayRate * absentDays) })
    }

    // Advance/loan deductions
    let advanceDeductions = 0
    const activeAdvances = await Advance.find({ tutorId, status: 'active' })
    for (const adv of activeAdvances) {
      if (adv.installmentFrequency === 'monthly') {
        const deductAmt = Math.min(adv.installmentAmount, adv.remainingBalance)
        if (deductAmt > 0) {
          deductions.push({ reason: `Advance repayment (${adv.type})`, amount: deductAmt })
          advanceDeductions += deductAmt
          adv.installments.push({ date: new Date(), amount: deductAmt, note: `Auto-deducted from salary ${month}/${year}` })
          adv.amountRepaid += deductAmt
          await adv.save()
        }
      }
    }

    // Overtime calculation
    let overtimeHours = 0
    let overtimeAmount = 0
    if (shiftConfig) {
      const [shiftEndH, shiftEndM] = (shiftConfig.defaultShiftEnd || '17:00').split(':').map(Number)
      const shiftEndMinutes = shiftEndH * 60 + shiftEndM
      const threshold = shiftConfig.overtimeThresholdMinutes || 0

      for (const a of attendance) {
        if (a.isOvertime && a.checkOutAt && a.checkInAt) {
          const checkOutMinutes = a.checkOutAt.getHours() * 60 + a.checkOutAt.getMinutes()
          const extraMins = checkOutMinutes - shiftEndMinutes - threshold
          if (extraMins > 0) {
            overtimeHours += extraMins / 60
          }
        }
      }
      overtimeHours = Math.round(overtimeHours * 100) / 100
      overtimeAmount = Math.round(overtimeHours * (shiftConfig.bonusRules?.extraHoursRate || 0))
    }

    // Bonus calculation
    const bonusBreakdown = []
    if (shiftConfig?.bonusRules) {
      const rules = shiftConfig.bonusRules
      if (rules.fullAttendanceBonus > 0 && absentDays === 0 && presentDays > 0) {
        bonusBreakdown.push({ reason: 'Full attendance bonus', amount: rules.fullAttendanceBonus })
      }
      if (rules.onTimeBonus > 0 && presentDays > 0) {
        const [shiftStartH, shiftStartM] = (shiftConfig.defaultShiftStart || '09:00').split(':').map(Number)
        const shiftStartMinutes = shiftStartH * 60 + shiftStartM
        const allOnTime = attendance.every(a => {
          if (a.status !== 'present' || !a.checkInAt) return true
          const checkInMinutes = a.checkInAt.getHours() * 60 + a.checkInAt.getMinutes()
          return checkInMinutes <= shiftStartMinutes + 5
        })
        if (allOnTime) {
          bonusBreakdown.push({ reason: 'On-time check-in bonus', amount: rules.onTimeBonus })
        }
      }
      if (overtimeAmount > 0) {
        bonusBreakdown.push({ reason: `Overtime (${overtimeHours}h)`, amount: overtimeAmount })
      }
    }

    const totalBonuses = bonusBreakdown.reduce((sum, b) => sum + b.amount, 0)
    const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0)
    const netPayable = baseAmount - totalDeductions + totalBonuses

    const record = await SalaryRecord.create({
      tutorId, month, year, baseAmount, currency,
      deductions, totalDeductions,
      bonuses: totalBonuses, bonusBreakdown,
      netPayable,
      presentDays, absentDays, totalHours,
      overtimeHours, overtimeAmount, advanceDeductions,
      generatedBy: req.userId,
    })

    await logActivity({ level: 'info', category: 'salary', action: 'salary_generated', message: `Salary generated for ${tutor.tutorId} (${month}/${year})`, req })

    res.status(201).json(record)
  } catch (err) {
    console.error('Generate salary error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateSalaryStatus(req, res) {
  try {
    const record = await SalaryRecord.findById(req.params.id)
    if (!record) return res.status(404).json({ error: 'Record not found' })

    const { status, bonuses, notes } = req.body
    if (status) {
      record.status = status
      if (status === 'paid' && !record.paidAt) {
        record.paidAt = new Date()
        // Generate receipt number
        const count = await SalaryRecord.countDocuments({ receiptNo: { $ne: '' } })
        record.receiptNo = `SR-${String(count + 1).padStart(5, '0')}`
      }
    }
    if (bonuses !== undefined) {
      record.bonuses = bonuses
      record.netPayable = record.baseAmount - record.totalDeductions + bonuses
    }
    if (notes) record.notes = notes
    await record.save()

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

    const records = await SalaryIncrement.find(filter)
      .populate('tutorId', 'name tutorId salary')
      .populate('approvedBy', 'displayName')
      .sort({ effectiveDate: -1 })
      .lean()

    res.json(records)
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

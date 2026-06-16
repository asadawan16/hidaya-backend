import Invoice from '../models/Invoice.js'
import SalaryRecord from '../models/SalaryRecord.js'
import TutorAttendance from '../models/TutorAttendance.js'
import TutorProfile from '../models/TutorProfile.js'
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

    // Check if already exists
    const existing = await SalaryRecord.findOne({ tutorId, month, year })
    if (existing) return res.status(400).json({ error: 'Salary record already exists for this period' })

    const tutor = await TutorProfile.findById(tutorId)
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' })

    // Get attendance for the month
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

    // Calculate deductions
    const deductions = []
    if (absentDays > 0) {
      const workingDays = presentDays + absentDays
      const perDayRate = workingDays > 0 ? baseAmount / workingDays : 0
      deductions.push({ reason: `Absent ${absentDays} day(s)`, amount: Math.round(perDayRate * absentDays) })
    }

    const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0)
    const netPayable = baseAmount - totalDeductions

    const record = await SalaryRecord.create({
      tutorId, month, year, baseAmount, currency,
      deductions, totalDeductions, netPayable,
      presentDays, absentDays, totalHours,
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
    if (status) record.status = status
    if (bonuses !== undefined) { record.bonuses = bonuses; record.netPayable = record.baseAmount - record.totalDeductions + bonuses }
    if (notes) record.notes = notes
    await record.save()

    res.json(record)
  } catch (err) {
    console.error('Update salary error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

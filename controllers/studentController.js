import Student from '../models/Student.js'
import PaymentLink from '../models/PaymentLink.js'
import Payment from '../models/Payment.js'

/* ── Admin: Create a student ── */
export async function create(req, res) {
  try {
    const { name, email, phone, notes } = req.body
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' })
    }

    const student = await Student.create({ name, email, phone, notes })
    res.status(201).json(student)
  } catch (err) {
    console.error('Student create error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: List students ── */
export async function list(req, res) {
  try {
    const { search } = req.query
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const filter = {}

    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ name: regex }, { email: regex }, { phone: regex }]
    }

    const total = await Student.countDocuments(filter)
    const pages = Math.max(1, Math.ceil(total / lim))
    const safePage = Math.min(pg, pages)
    const students = await Student.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)

    res.json({ students, total, page: safePage, pages })
  } catch (err) {
    console.error('Student list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: Search students (lightweight, for dropdowns) ── */
export async function search(req, res) {
  try {
    const q = req.query.q || ''
    if (!q.trim()) return res.json([])

    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    const students = await Student.find({
      $or: [{ name: regex }, { email: regex }, { phone: regex }],
    })
      .select('name email phone')
      .sort({ name: 1 })
      .limit(10)

    res.json(students)
  } catch (err) {
    console.error('Student search error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: Get student by ID ── */
export async function getById(req, res) {
  try {
    const student = await Student.findById(req.params.id)
    if (!student) return res.status(404).json({ error: 'Student not found' })
    res.json(student)
  } catch (err) {
    console.error('Student getById error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: Update a student ── */
export async function update(req, res) {
  try {
    const { name, email, phone, notes } = req.body
    const updateData = {}
    if (name !== undefined) updateData.name = name
    if (email !== undefined) updateData.email = email
    if (phone !== undefined) updateData.phone = phone
    if (notes !== undefined) updateData.notes = notes

    const student = await Student.findByIdAndUpdate(req.params.id, updateData, { new: true })
    if (!student) return res.status(404).json({ error: 'Student not found' })
    res.json(student)
  } catch (err) {
    console.error('Student update error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: Delete a student ── */
export async function remove(req, res) {
  try {
    const student = await Student.findByIdAndDelete(req.params.id)
    if (!student) return res.status(404).json({ error: 'Student not found' })
    res.json({ success: true })
  } catch (err) {
    console.error('Student delete error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: Get payment summary for a student ── */
export async function getPayments(req, res) {
  try {
    const student = await Student.findById(req.params.id)
    if (!student) return res.status(404).json({ error: 'Student not found' })

    // All payments for this student (handles reusable links + multiple links)
    const payments = await Payment.find({ student: req.params.id })
      .sort({ createdAt: -1 })
      .populate('paymentLink', 'description token expiresAfterPayment')

    // All payment links for this student
    const links = await PaymentLink.find({ student: req.params.id })
      .select('description amount currency status token expiresAfterPayment createdAt')
      .sort({ createdAt: -1 })

    // Stats from actual payments
    const completed = payments.filter(p => p.status === 'completed')
    const totalPaid = completed.reduce((sum, p) => sum + (p.amount || 0), 0)

    // Group by currency
    const byCurrency = {}
    for (const p of completed) {
      const cur = p.currency || 'PKR'
      byCurrency[cur] = (byCurrency[cur] || 0) + (p.amount || 0)
    }

    res.json({
      student,
      payments,
      links,
      stats: {
        totalLinks: links.length,
        totalPayments: payments.length,
        completedPayments: completed.length,
        pendingPayments: payments.filter(p => p.status === 'pending').length,
        failedPayments: payments.filter(p => p.status === 'failed').length,
        totalPaid,
        byCurrency,
      },
    })
  } catch (err) {
    console.error('Student getPayments error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

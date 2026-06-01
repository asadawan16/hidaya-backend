import Enrollment from '../models/Enrollment.js'
import { notifyAdmin, enrollmentEmail } from '../services/mailer.js'

export async function create(req, res) {
  try {
    const { name, email, phone, message, source } = req.body
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' })
    }

    const enrollment = await Enrollment.create({
      name: name.trim(),
      email: email.trim(),
      phone: phone?.trim(),
      message: message?.trim(),
      source: source || 'hero_form',
    })

    // Notify admin via email (non-blocking)
    notifyAdmin(enrollmentEmail(enrollment.toObject())).catch(() => {})

    res.status(201).json({ message: 'Submitted successfully', id: enrollment._id })
  } catch (err) {
    console.error('Enrollment create error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function list(req, res) {
  try {
    const { status, source, page = 1, limit = 20 } = req.query
    const filter = {}
    if (status) filter.status = status
    if (source) filter.source = source

    const total = await Enrollment.countDocuments(filter)
    const enrollments = await Enrollment.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))

    res.json({ enrollments, total, page: Number(page), pages: Math.ceil(total / limit) })
  } catch (err) {
    console.error('Enrollment list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function stats(req, res) {
  try {
    const [total, newCount, contacted, enrolled] = await Promise.all([
      Enrollment.countDocuments(),
      Enrollment.countDocuments({ status: 'new' }),
      Enrollment.countDocuments({ status: 'contacted' }),
      Enrollment.countDocuments({ status: 'enrolled' }),
    ])
    res.json({ total, new: newCount, contacted, enrolled })
  } catch (err) {
    console.error('Enrollment stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateStatus(req, res) {
  try {
    const { status } = req.body
    const enrollment = await Enrollment.findByIdAndUpdate(req.params.id, { status }, { new: true })
    if (!enrollment) return res.status(404).json({ error: 'Not found' })
    res.json(enrollment)
  } catch (err) {
    console.error('Enrollment update error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

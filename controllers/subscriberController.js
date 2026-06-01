import Subscriber from '../models/Subscriber.js'
import { sendToUser, newsletterEmail } from '../services/mailer.js'

// Public — subscribe
export async function subscribe(req, res) {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'Email is required' })

    const existing = await Subscriber.findOne({ email: email.trim().toLowerCase() })
    if (existing) {
      if (existing.status === 'unsubscribed') {
        existing.status = 'active'
        await existing.save()
        return res.json({ message: 'Welcome back! You have been re-subscribed.' })
      }
      return res.json({ message: 'You are already subscribed.' })
    }

    await Subscriber.create({ email: email.trim() })
    res.status(201).json({ message: 'Subscribed successfully' })
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ message: 'You are already subscribed.' })
    }
    console.error('Subscribe error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Public — unsubscribe
export async function unsubscribe(req, res) {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'Email is required' })

    const subscriber = await Subscriber.findOne({ email: email.trim().toLowerCase() })
    if (!subscriber) return res.status(404).json({ error: 'Email not found' })

    subscriber.status = 'unsubscribed'
    await subscriber.save()
    res.json({ message: 'You have been unsubscribed.' })
  } catch (err) {
    console.error('Unsubscribe error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Admin — list subscribers
export async function list(req, res) {
  try {
    const { status, page = 1, limit = 20, startDate, endDate } = req.query
    const filter = {}
    if (status) filter.status = status
    if (startDate || endDate) {
      filter.createdAt = {}
      if (startDate) filter.createdAt.$gte = new Date(startDate)
      if (endDate) filter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999))
    }

    const total = await Subscriber.countDocuments(filter)
    const subscribers = await Subscriber.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))

    res.json({ subscribers, total, page: Number(page), pages: Math.ceil(total / limit) })
  } catch (err) {
    console.error('Subscriber list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Admin — stats
export async function stats(req, res) {
  try {
    const [total, active, unsubscribed] = await Promise.all([
      Subscriber.countDocuments(),
      Subscriber.countDocuments({ status: 'active' }),
      Subscriber.countDocuments({ status: 'unsubscribed' }),
    ])

    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)

    const monthly = await Subscriber.aggregate([
      { $match: { status: 'active', createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])

    res.json({ total, active, unsubscribed, monthly })
  } catch (err) {
    console.error('Subscriber stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Admin — delete subscriber
export async function remove(req, res) {
  try {
    const subscriber = await Subscriber.findByIdAndDelete(req.params.id)
    if (!subscriber) return res.status(404).json({ error: 'Not found' })
    res.json({ message: 'Subscriber removed' })
  } catch (err) {
    console.error('Subscriber remove error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Admin — send newsletter to all active subscribers
export async function sendNewsletter(req, res) {
  try {
    const { subject, body } = req.body
    if (!subject || !body) {
      return res.status(400).json({ error: 'Subject and body are required' })
    }

    const activeSubscribers = await Subscriber.find({ status: 'active' }).select('email')
    if (activeSubscribers.length === 0) {
      return res.status(400).json({ error: 'No active subscribers' })
    }

    const emailContent = newsletterEmail({ subject, body })

    // Send emails in batches (non-blocking)
    let sent = 0
    let failed = 0
    const batchSize = 10

    for (let i = 0; i < activeSubscribers.length; i += batchSize) {
      const batch = activeSubscribers.slice(i, i + batchSize)
      const results = await Promise.allSettled(
        batch.map(sub =>
          sendToUser({ to: sub.email, subject: emailContent.subject, html: emailContent.html })
        )
      )
      results.forEach(r => r.status === 'fulfilled' ? sent++ : failed++)
    }

    res.json({ message: `Newsletter sent`, sent, failed, total: activeSubscribers.length })
  } catch (err) {
    console.error('Send newsletter error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

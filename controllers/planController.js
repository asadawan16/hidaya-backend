import Plan from '../models/Plan.js'

// Default plans — used as seed data and frontend fallback
const DEFAULTS = [
  {
    planId: '2-days',
    name: '2 Days / Week',
    sessions: '8 classes/month',
    duration: '30 min each',
    price: 10000,
    features: ['One-to-one sessions', 'Flexible scheduling', 'Progress reports', 'Free trial class'],
    popular: false,
    active: true,
  },
  {
    planId: '3-days',
    name: '3 Days / Week',
    sessions: '12 classes/month',
    duration: '30 min each',
    price: 14000,
    features: ['One-to-one sessions', 'Flexible scheduling', 'Progress reports', 'Free trial class', 'Backup teacher'],
    popular: true,
    active: true,
  },
  {
    planId: '5-days',
    name: '5 Days / Week',
    sessions: '20 classes/month',
    duration: '30 min each',
    price: 21000,
    features: ['One-to-one sessions', 'Flexible scheduling', 'Progress reports', 'Free trial class', 'Backup teacher', 'Priority support'],
    popular: false,
    active: true,
  },
]

/* ── Public: Get active plans (for fee page) ── */
export async function listPublic(_req, res) {
  try {
    let plans = await Plan.find({ active: true }).sort({ price: 1 })
    // If no plans in DB yet, seed defaults and return them
    if (plans.length === 0) {
      plans = await Plan.insertMany(DEFAULTS)
    }
    res.json(plans)
  } catch (err) {
    console.error('Plans list error:', err)
    // Return defaults as ultimate fallback
    res.json(DEFAULTS)
  }
}

/* ── Admin: Get all plans (including inactive) ── */
export async function listAll(_req, res) {
  try {
    let plans = await Plan.find().sort({ price: 1 })
    if (plans.length === 0) {
      plans = await Plan.insertMany(DEFAULTS)
    }
    res.json(plans)
  } catch (err) {
    console.error('Plans listAll error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: Update a plan ── */
export async function update(req, res) {
  try {
    const { price, name, sessions, duration, features, popular, active } = req.body
    const updateData = {}

    if (price !== undefined) {
      const p = Number(price)
      if (isNaN(p) || p < 20) return res.status(400).json({ error: 'Price must be at least Rs. 20' })
      updateData.price = p
    }
    if (req.body.prices !== undefined) {
      const p = req.body.prices
      updateData.prices = {
        PKR: p.PKR != null ? Number(p.PKR) : undefined,
        USD: p.USD != null ? Number(p.USD) : undefined,
        EUR: p.EUR != null ? Number(p.EUR) : undefined,
        GBP: p.GBP != null ? Number(p.GBP) : undefined,
      }
    }
    if (name !== undefined) updateData.name = name
    if (sessions !== undefined) updateData.sessions = sessions
    if (duration !== undefined) updateData.duration = duration
    if (features !== undefined) updateData.features = features
    if (popular !== undefined) updateData.popular = popular
    if (active !== undefined) updateData.active = active

    const plan = await Plan.findByIdAndUpdate(req.params.id, updateData, { new: true })
    if (!plan) return res.status(404).json({ error: 'Plan not found' })
    res.json(plan)
  } catch (err) {
    console.error('Plan update error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

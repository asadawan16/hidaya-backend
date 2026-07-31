import DiscountCode from '../models/DiscountCode.js'
import PaymentLink from '../models/PaymentLink.js'

/* ── Admin: Create a discount code ── */
export async function create(req, res) {
  try {
    const { code, discountAmount, currency, usageType, description } = req.body
    if (!discountAmount || !currency) {
      return res.status(400).json({ error: 'discountAmount and currency are required' })
    }
    if (discountAmount <= 0) {
      return res.status(400).json({ error: 'discountAmount must be positive' })
    }
    const validCurrencies = ['PKR', 'USD', 'EUR', 'GBP', 'CAD']
    if (!validCurrencies.includes(currency)) {
      return res.status(400).json({ error: 'Invalid currency' })
    }

    const codeData = {
      discountAmount: Number(discountAmount),
      currency,
      usageType: usageType === 'recurring' ? 'recurring' : 'one_time',
      description: description || '',
    }
    if (code && code.trim()) codeData.code = code.trim().toUpperCase()

    const discount = await DiscountCode.create(codeData)
    res.status(201).json(discount)
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'This discount code already exists' })
    }
    console.error('DiscountCode create error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: List discount codes ── */
export async function list(req, res) {
  try {
    const { currency, usageType, isActive } = req.query
    const filter = {}
    if (currency) filter.currency = currency
    if (usageType) filter.usageType = usageType
    if (isActive !== undefined) filter.isActive = isActive === 'true'

    const codes = await DiscountCode.find(filter).sort({ createdAt: -1 })
    res.json(codes)
  } catch (err) {
    console.error('DiscountCode list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: Toggle active/inactive ── */
export async function toggle(req, res) {
  try {
    const dc = await DiscountCode.findById(req.params.id)
    if (!dc) return res.status(404).json({ error: 'Discount code not found' })
    dc.isActive = !dc.isActive
    await dc.save()
    res.json(dc)
  } catch (err) {
    console.error('DiscountCode toggle error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Admin: Delete a discount code ── */
export async function remove(req, res) {
  try {
    const dc = await DiscountCode.findByIdAndDelete(req.params.id)
    if (!dc) return res.status(404).json({ error: 'Discount code not found' })
    res.json({ success: true })
  } catch (err) {
    console.error('DiscountCode delete error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Public: Validate a discount code ──
   Supports two modes:
   - { code, token }                   → validates against a payment link
   - { code, currency, amount }        → validates for a direct plan payment
─────────────────────────────────────── */
export async function validate(req, res) {
  try {
    const { code, token, currency: directCurrency, amount: directAmount } = req.body
    if (!code) {
      return res.status(400).json({ valid: false, message: 'Discount code is required' })
    }

    let paymentCurrency, paymentAmount

    if (token) {
      const link = await PaymentLink.findOne({ token })
      if (!link) return res.status(404).json({ valid: false, message: 'Payment link not found' })
      if (link.status !== 'active') {
        return res.status(400).json({ valid: false, message: 'Payment link is no longer active' })
      }
      paymentCurrency = link.currency
      paymentAmount = link.amount
    } else if (directCurrency && directAmount) {
      const validCurrencies = ['PKR', 'USD', 'EUR', 'GBP', 'CAD']
      if (!validCurrencies.includes(directCurrency)) {
        return res.status(400).json({ valid: false, message: 'Invalid currency' })
      }
      paymentCurrency = directCurrency
      paymentAmount = Number(directAmount)
    } else {
      return res.status(400).json({ valid: false, message: 'Provide either a payment link token or currency + amount' })
    }

    const dc = await DiscountCode.findOne({ code: code.trim().toUpperCase() })
    if (!dc) return res.status(400).json({ valid: false, message: 'Invalid discount code' })
    if (!dc.isActive) return res.status(400).json({ valid: false, message: 'This discount code is no longer active' })
    if (dc.currency !== paymentCurrency) {
      return res.status(400).json({ valid: false, message: `This code is for ${dc.currency} payments only` })
    }
    if (dc.usageType === 'one_time' && dc.timesUsed >= 1) {
      return res.status(400).json({ valid: false, message: 'This discount code has already been used' })
    }
    if (dc.discountAmount >= paymentAmount) {
      return res.status(400).json({ valid: false, message: 'Discount cannot exceed the payment amount' })
    }

    const sym = { PKR: 'Rs.', USD: '$', EUR: '€', GBP: '£', CAD: 'C$' }[dc.currency] || dc.currency
    res.json({
      valid: true,
      discountAmount: dc.discountAmount,
      currency: dc.currency,
      finalAmount: paymentAmount - dc.discountAmount,
      usageType: dc.usageType,
      message: `Discount applied: -${sym} ${dc.discountAmount.toLocaleString()}`,
    })
  } catch (err) {
    console.error('DiscountCode validate error:', err)
    res.status(500).json({ valid: false, message: 'Server error' })
  }
}

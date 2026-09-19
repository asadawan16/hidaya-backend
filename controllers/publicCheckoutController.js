import PaymentLink from '../models/PaymentLink.js'
import Enrollment from '../models/Enrollment.js'
import { getChannel, publicChannel, priceOffer } from '../config/channelOffers.js'
import { paySiteUrl } from '../config/sites.js'
import { generateInvoiceNo } from '../services/paymentLinkFulfillment.js'
import { normalizeGatewayFields } from '../utils/paymentLinkOptions.js'
import { isStripeEnabled } from '../services/stripe.js'
import { logActivity } from '../utils/activityLogger.js'

/*
 * Self-serve checkout for the satellite marketing sites.
 *
 * qurantutornow.com has no checkout of its own. A visitor picks a plan there,
 * this endpoint mints a Stripe payment link priced from the server-side channel
 * book, and the browser is sent to hidaya.online/pay/:token to finish.
 *
 * Why the redirect rather than running Stripe on the ad site: one origin owns
 * the whole payment surface. Success/cancel URLs, the webhook, and the receipt
 * page all live on hidaya.online no matter which site the payer came from, so
 * adding a third or fourth landing site later needs no Stripe changes at all.
 *
 * The request never carries an amount. It carries a planId, and the money comes
 * from config/channelOffers.js — otherwise anyone could POST `amount: 1`.
 */

/* ── Public: the price book a marketing site renders from ── */
export async function listOffers(req, res) {
  try {
    const channel = getChannel(req.params.channel)
    if (!channel) return res.status(404).json({ error: 'Unknown checkout channel' })
    res.json({ ...publicChannel(channel), stripeReady: isStripeEnabled() })
  } catch (err) {
    console.error('listOffers error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── Public: start a checkout, get back a hidaya.online pay URL ── */
export async function startCheckout(req, res) {
  try {
    if (!isStripeEnabled()) {
      return res.status(503).json({ error: 'Online payment is temporarily unavailable. Please contact us on WhatsApp.' })
    }

    const { channel: channelKey, planId, currency, billing, students, name, email, phone, notes } = req.body || {}

    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ error: 'Name and email are required' })
    }

    // The book decides the money AND the billing shape — the body carries a
    // choice ('annual', 'monthly'…) and a head count, never a price, never an
    // interval and never a discount.
    const priced = priceOffer({ channel: channelKey, planId, currency, billing, students })
    if (priced.error) return res.status(400).json({ error: priced.error })
    const { channel, plan, currency: cur, amount, perMonth, students: heads, siblingOff: famOff, mode } = priced

    const recurringWanted = !!mode.recurring
    const yearly = mode.term === 'annual'
    const gatewayFields = normalizeGatewayFields({
      gateway: 'stripe',
      paymentMode: recurringWanted ? 'recurring' : 'one_time',
      recurring: { interval: mode.interval || 'month', intervalCount: 1, trialDays: 0 },
    })
    if (gatewayFields.error) return res.status(400).json({ error: gatewayFields.error })

    // What the payer sees on the pay page and on the receipt afterwards. An
    // annual payer, or a parent paying for three children at once, must be
    // able to read back what the lump sum bought.
    const family = heads > 1
    const each = `${cur} ${perMonth}${family ? ' per child' : ''} a month`
    const termLabel = [
      yearly ? `12 months at ${each}` : recurringWanted ? 'Auto-pay monthly' : 'One-time payment',
      family ? `${heads} students${famOff ? ` · ${Math.round(famOff * 100)}% sibling discount` : ''}` : null,
      !yearly && family ? each : null,
    ].filter(Boolean).join(' · ')

    const link = await PaymentLink.create({
      payeeName: name.trim(),
      payeeEmail: email.trim().toLowerCase(),
      payeePhone: phone?.trim() || '',
      description: `${plan.name} — ${plan.sessions}${yearly ? ', 12 months' : ''}${family ? `, ${heads} students` : ''} (${channel.label})`,
      amount,
      currency: cur,
      items: [
        ...plan.features,
        family ? `${heads} students${famOff ? ` — ${Math.round(famOff * 100)}% sibling discount on every fee` : ''}` : null,
        yearly ? `Twelve months paid up front — ${each}` : null,
      ].filter(Boolean),
      listType: 'bullet',
      invoiceNo: await generateInvoiceNo(),
      source: channel.key,
      notes: [
        `Self-serve checkout from ${channel.site}`,
        termLabel,
        recurringWanted && yearly ? 'Renews yearly' : null,
        notes?.trim(),
      ].filter(Boolean).join(' · '),
      // A one-off self-serve link is single-use; a recurring one must stay open
      // for every cycle (normalizeGatewayFields already forces that).
      expiresAfterPayment: !recurringWanted,
      ...gatewayFields.values,
    })

    // Capture the person as a lead too. An ad click that reaches the pay page
    // and then hesitates is exactly the contact worth following up, and without
    // this it would leave no trace anywhere in the portal.
    await recordCheckoutLead({ channel, plan, cur, amount, name, email, phone, termLabel })

    logActivity({
      level: 'info',
      category: 'payment_link',
      action: 'public_checkout.start',
      message: `${channel.label} checkout started — ${plan.name}, ${cur} ${amount} (${termLabel}) for ${name.trim()}`,
      req,
      meta: {
        channel: channel.key,
        planId: plan.id,
        currency: cur,
        amount,
        term: mode.term,
        students: heads,
        siblingOff: famOff,
        recurring: recurringWanted,
        paymentLinkId: link._id,
      },
    })

    res.status(201).json({
      payUrl: `${paySiteUrl()}/pay/${link.token}`,
      token: link.token,
      amount,
      currency: cur,
      term: mode.term,
      students: heads,
      perStudent: perMonth,
      recurring: recurringWanted,
      invoiceNo: link.invoiceNo,
    })
  } catch (err) {
    console.error('startCheckout error:', err)
    res.status(500).json({ error: 'Could not start checkout. Please try again.' })
  }
}

/* ── Public: free-trial enquiry from a marketing site ──
 * Writes the same Enrollment document the hidaya.online free-class form does,
 * so it lands in the portal's Leads board with no new plumbing — only the
 * `source` tells the two funnels apart. */
export async function submitTrial(req, res) {
  try {
    const { channel: channelKey, name, email, phone, message, preferredTime, course, referralSource } = req.body || {}

    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ error: 'Name and email are required' })
    }

    const channel = getChannel(channelKey)
    const source = channel?.key === 'qurantutornow' ? 'qurantutornow' : 'free_class'

    const details = [
      course?.trim() && `Course: ${course.trim()}`,
      preferredTime?.trim() && `Preferred time: ${preferredTime.trim()}`,
      message?.trim(),
      channel && `Submitted on ${channel.site}`,
    ].filter(Boolean).join(' · ')

    const enrollment = await Enrollment.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phone: phone?.trim(),
      message: details,
      source,
      referralSource: referralSource?.trim() || (channel ? 'Google Ads' : ''),
    })

    logActivity({
      level: 'info',
      category: 'enrollment',
      action: 'enrollment_created',
      message: `Free trial request from ${name.trim()} (${email.trim()}) via ${source}`,
      req,
      meta: { enrollmentId: enrollment._id, source, channel: channel?.key || null },
    })

    // Email is best-effort — a failed SMTP call must not lose the lead.
    notifyTrial(enrollment).catch(() => {})

    res.status(201).json({ message: 'Submitted successfully', id: enrollment._id })
  } catch (err) {
    console.error('submitTrial error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/* ── helpers ── */

async function notifyTrial(enrollment) {
  const { notifyAdmin, sendToUser, enrollmentEmail, enrollmentConfirmationEmail } = await import('../services/mailer.js')
  const data = enrollment.toObject()
  notifyAdmin(enrollmentEmail(data)).catch(() => {})
  sendToUser({ to: data.email, ...enrollmentConfirmationEmail(data) }).catch(() => {})
}

/* One lead per email per channel while it is still unworked — a payer who
 * retries checkout three times is one person, not three leads. */
async function recordCheckoutLead({ channel, plan, cur, amount, name, email, phone, termLabel }) {
  const addr = email.trim().toLowerCase()
  const source = channel.key === 'qurantutornow' ? 'qurantutornow' : 'hero_form'

  const open = await Enrollment.findOne({ email: addr, source, status: 'new' })
  const line = `Checkout started: ${plan.name} — ${cur} ${amount} (${termLabel})`

  if (open) {
    // Keep the newest intent visible without spawning a duplicate card.
    open.message = open.message?.includes(line) ? open.message : [open.message, line].filter(Boolean).join(' · ')
    if (!open.phone && phone?.trim()) open.phone = phone.trim()
    await open.save()
    return open
  }

  return Enrollment.create({
    name: name.trim(),
    email: addr,
    phone: phone?.trim(),
    message: `${line} · via ${channel.site}`,
    source,
    referralSource: 'Google Ads',
  })
}

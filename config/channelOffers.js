/*
 * Channel price books.
 *
 * qurantutornow.com is a separate acquisition funnel (Google Ads) with its own
 * published rates. Those rates CANNOT come from the `Plan` collection: that is
 * what hidaya.online's own fee page sells, and the two must be free to move
 * independently.
 *
 * They were originally set above hidaya.online's, on the theory that an ad lead
 * converts at a different price point. They are not any more: $80/month for
 * twenty half-hour classes sat above what a parent finds by searching for ten
 * seconds, and the click is paid for either way. The whole table moved down one
 * step in Sep 2026 — the top plan now sits where the middle one did, and the
 * ceiling is $55.
 *
 * This file is the authority for what a channel checkout charges. The channel's
 * marketing site renders its price cards from the SAME book at runtime
 * (`GET /api/public/offers/:channel`), so the price displayed is always the
 * price charged — the browser never names an amount, it names a planId and the
 * money is looked up here.
 *
 * Changing a price: edit it here and redeploy the API. The marketing site picks
 * it up on the next page load; its own static copy in
 * `quranTutor/src/data/content.js` is only the pre-render/offline fallback.
 *
 * Sep 2026, second pass — the ad spend is bringing traffic and the fee table
 * was the page it died on, so three things were added to it:
 *
 *   `list`    the rate this channel published until this month. The card shows
 *             it struck through, which is a true statement about a real price
 *             change and not a manufactured "was". Do not invent one.
 *   `annual`  the per-month rate when twelve months are paid up front. A
 *             checkout priced annually charges this × 12.
 *   `days`    which days the plan actually runs, because the answer used to
 *             cost a WhatsApp message before anyone could decide.
 *
 * The two-day plan is gone — nobody picked it — and a weekend plan of two
 * 90-minute classes replaces it.
 */

/* The annual discount, as one knob. The published `annual` maps below are this
 * applied to each monthly rate and rounded; annualRate() recomputes it for any
 * plan that omits the map, so the two can never disagree by more than the
 * rounding. Mirrored in the marketing site's content.js as ANNUAL_OFF. */
export const ANNUAL_OFF = 0.11

/* What every plan includes — one list, shared by all three, and deliberately
 * so. The features used to grow down the row (backup cover from the middle
 * plan, priority support only at the top), which told a parent picking the
 * cheapest option they were buying the lesser service. They are not: the plans
 * differ in days a week and in nothing else. Mirrored in the marketing site's
 * content.js as PLAN_FEATURES, and itemised on the payment page. */
export const PLAN_FEATURES = [
  'One-to-one with the same tutor, every class',
  'Your own time slot, in your own time zone',
  'A male or female tutor, your choice',
  'Monthly progress and test report',
  'Backup teacher cover and make-up classes',
  'Student and parent portal access',
  'Priority support from a coordinator',
  'Free trial class before you pay anything',
]

/* Sibling tiers, by head count. `off` comes off EVERY enrolled child's fee,
 * not only the second one's. Published to the marketing site so the selector
 * on the fee table and the arithmetic here are the same two numbers, and
 * capped so a mistyped `students: 400` cannot mint a link for a year of a
 * class nobody asked for. */
export const SIBLING_TIERS = [
  { min: 2, off: 0.10 },
  { min: 3, off: 0.15 },
]
export const MAX_STUDENTS = 10

export function siblingOff(students, tiers = SIBLING_TIERS) {
  return tiers.reduce((best, t) => (students >= t.min && t.off > best ? t.off : best), 0)
}

/* Money is rounded to the cent, never to whole units: 10% off $42 is $37.80
 * and that is what the card says, so that is what the card is charged. */
const cents = n => Math.round(Number(n || 0) * 100) / 100

export function annualRate(plan, currency) {
  const explicit = plan?.annual?.[currency]
  if (explicit > 0) return explicit
  const raw = Number(plan?.prices?.[currency] || 0) * (1 - ANNUAL_OFF)
  return currency === 'PKR' ? Math.round(raw / 100) * 100 : Math.round(raw)
}

export const CHANNELS = {
  qurantutornow: {
    key: 'qurantutornow',
    label: 'Quran Tutor',
    site: 'https://qurantutornow.com',
    // Order matters — this is the order the currency switcher renders in.
    currencies: ['USD', 'GBP', 'EUR', 'PKR'],
    defaultCurrency: 'USD',
    siblings: SIBLING_TIERS,
    // Cheapest first: this is also the order the three cards render in, and the
    // recommended plan sits in the middle of the row rather than at one end.
    plans: [
      {
        id: 'weekend',
        name: 'Weekend classes',
        sessions: '8 classes a month',
        duration: '90 minutes each',
        days: 'Saturday & Sunday',
        flag: 'Best value',
        prices: { USD: 40, GBP: 32, EUR: 38, PKR: 10000 },
        list: { USD: 60, GBP: 48, EUR: 57, PKR: 15000 },
        annual: { USD: 36, GBP: 28, EUR: 34, PKR: 8900 },
        features: PLAN_FEATURES,
        popular: false,
      },
      {
        id: '3-days',
        name: '3 days a week',
        sessions: '12 classes a month',
        duration: '30 minutes each',
        days: 'Mon–Wed or Thu–Sat',
        flag: 'Most families choose this',
        prices: { USD: 42, GBP: 34, EUR: 40, PKR: 10500 },
        list: { USD: 60, GBP: 48, EUR: 57, PKR: 15000 },
        annual: { USD: 37, GBP: 30, EUR: 36, PKR: 9300 },
        features: PLAN_FEATURES,
        popular: true,
      },
      {
        id: '5-days',
        name: '5 days a week',
        sessions: '20 classes a month',
        duration: '30 minutes each',
        days: 'Monday – Friday',
        // Never "Best for Hifz students" — a ribbon naming who a plan is for
        // reads as who it is NOT for, and the adult fixing their Tajweed
        // quietly picks a cheaper one.
        flag: 'Fastest progress',
        prices: { USD: 55, GBP: 44, EUR: 52, PKR: 14000 },
        list: { USD: 80, GBP: 64, EUR: 75, PKR: 20000 },
        annual: { USD: 49, GBP: 39, EUR: 46, PKR: 12500 },
        features: PLAN_FEATURES,
        popular: false,
      },
    ],
  },
}

export function getChannel(key) {
  return CHANNELS[String(key || '').trim()] || null
}

/* Public shape — what the marketing site is allowed to see. The card renders
 * every one of these fields, so a new one has to be added here as well as to
 * the plan or it simply never arrives. */
export function publicChannel(channel) {
  return {
    channel: channel.key,
    label: channel.label,
    currencies: channel.currencies,
    defaultCurrency: channel.defaultCurrency,
    annualOff: ANNUAL_OFF,
    siblings: channel.siblings || [],
    maxStudents: MAX_STUDENTS,
    plans: channel.plans.map(p => ({
      id: p.id,
      name: p.name,
      sessions: p.sessions,
      duration: p.duration,
      days: p.days,
      flag: p.flag,
      prices: p.prices,
      list: p.list,
      annual: p.annual,
      features: p.features,
      popular: p.popular,
    })),
  }
}

/*
 * How a billing choice maps to money and to a Stripe mode.
 *
 * These four strings are the contract with the marketing site's PayNow modal.
 * `term` picks which rate is charged; `recurring` picks whether a mandate is
 * taken. An unrecognised value falls back to a single month, which is the
 * cheapest possible mistake to make.
 */
const BILLING_MODES = {
  one_time: { term: 'monthly', months: 1, recurring: false },
  monthly: { term: 'monthly', months: 1, recurring: true, interval: 'month' },
  annual_one_time: { term: 'annual', months: 12, recurring: false },
  annual: { term: 'annual', months: 12, recurring: true, interval: 'year' },
}

export function billingMode(billing) {
  return BILLING_MODES[String(billing || '').trim()] || BILLING_MODES.one_time
}

/*
 * Resolve a checkout request to real money.
 * Returns { channel, plan, currency, amount, perMonth, students, siblingOff,
 * mode } or { error } — never trusts an amount from the request body, only a
 * plan, a billing choice and a head count.
 */
export function priceOffer({ channel: channelKey, planId, currency, billing, students }) {
  const channel = getChannel(channelKey)
  if (!channel) return { error: 'Unknown checkout channel' }

  const plan = channel.plans.find(p => p.id === String(planId || '').trim())
  if (!plan) return { error: 'Unknown plan' }

  const cur = String(currency || channel.defaultCurrency).toUpperCase()
  if (!channel.currencies.includes(cur)) return { error: `Currency ${cur} is not available for this plan` }

  const heads = Math.round(Number(students) || 1)
  if (heads < 1) return { error: 'Number of students must be at least 1' }
  if (heads > MAX_STUDENTS) {
    return { error: `Please contact us to enrol more than ${MAX_STUDENTS} students at once` }
  }

  const mode = billingMode(billing)
  const rate = mode.term === 'annual' ? annualRate(plan, cur) : plan.prices[cur]
  if (!rate || rate <= 0) return { error: `No price configured for ${plan.name} in ${cur}` }

  const off = siblingOff(heads, channel.siblings || [])
  const perMonth = cents(rate * (1 - off))

  return {
    channel,
    plan,
    currency: cur,
    amount: cents(perMonth * mode.months * heads),
    perMonth,
    students: heads,
    siblingOff: off,
    mode,
  }
}

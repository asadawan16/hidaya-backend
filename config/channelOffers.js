/*
 * Channel price books.
 *
 * qurantutornow.com is a separate acquisition funnel (Google Ads) with its own
 * published rates — deliberately higher than hidaya.online's, because an ad
 * lead converts at a different price point. Those rates therefore CANNOT come
 * from the `Plan` collection: that is what hidaya.online's own fee page sells,
 * and the two must be free to move independently.
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
 */

export const CHANNELS = {
  qurantutornow: {
    key: 'qurantutornow',
    label: 'Quran Tutor',
    site: 'https://qurantutornow.com',
    // Order matters — this is the order the currency switcher renders in.
    currencies: ['USD', 'GBP', 'EUR', 'PKR'],
    defaultCurrency: 'USD',
    plans: [
      {
        id: '2-days',
        name: '2 days a week',
        sessions: '8 classes a month',
        duration: '30 minutes each',
        prices: { USD: 40, GBP: 32, EUR: 38, PKR: 10000 },
        features: ['One-to-one sessions', 'Flexible scheduling', 'Monthly progress report', 'Free trial class'],
        popular: false,
      },
      {
        id: '3-days',
        name: '3 days a week',
        sessions: '12 classes a month',
        duration: '30 minutes each',
        prices: { USD: 55, GBP: 44, EUR: 52, PKR: 14000 },
        features: ['One-to-one sessions', 'Flexible scheduling', 'Monthly progress report', 'Free trial class', 'Backup teacher cover'],
        popular: true,
      },
      {
        id: '5-days',
        name: '5 days a week',
        sessions: '20 classes a month',
        duration: '30 minutes each',
        prices: { USD: 80, GBP: 64, EUR: 76, PKR: 21000 },
        features: ['One-to-one sessions', 'Flexible scheduling', 'Monthly progress report', 'Free trial class', 'Backup teacher cover', 'Priority support'],
        popular: false,
      },
    ],
  },
}

export function getChannel(key) {
  return CHANNELS[String(key || '').trim()] || null
}

/* Public shape — what the marketing site is allowed to see. */
export function publicChannel(channel) {
  return {
    channel: channel.key,
    label: channel.label,
    currencies: channel.currencies,
    defaultCurrency: channel.defaultCurrency,
    plans: channel.plans.map(p => ({
      id: p.id,
      name: p.name,
      sessions: p.sessions,
      duration: p.duration,
      prices: p.prices,
      features: p.features,
      popular: p.popular,
    })),
  }
}

/*
 * Resolve a checkout request to real money.
 * Returns { channel, plan, currency, amount } or { error } — never trusts an
 * amount from the request body.
 */
export function priceOffer({ channel: channelKey, planId, currency }) {
  const channel = getChannel(channelKey)
  if (!channel) return { error: 'Unknown checkout channel' }

  const plan = channel.plans.find(p => p.id === String(planId || '').trim())
  if (!plan) return { error: 'Unknown plan' }

  const cur = String(currency || channel.defaultCurrency).toUpperCase()
  if (!channel.currencies.includes(cur)) return { error: `Currency ${cur} is not available for this plan` }

  const amount = plan.prices[cur]
  if (!amount || amount <= 0) return { error: `No price configured for ${plan.name} in ${cur}` }

  return { channel, plan, currency: cur, amount }
}

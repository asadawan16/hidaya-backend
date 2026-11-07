import CurrencyRates from '../models/CurrencyRates.js'

export const CURRENCIES = ['PKR', 'USD', 'EUR', 'GBP', 'CAD']
export const DEFAULT_RATES = { PKR: 1, USD: 278, EUR: 312, GBP: 355, CAD: 205 }

// Rates are read on every revenue / dues request; a short cache keeps that to
// one query a minute. Saving rates clears it.
let cache = null
let cachedAt = 0
const TTL_MS = 60 * 1000

export async function getRatesDoc() {
  const doc = await CurrencyRates.findOne({ key: 'default' }).lean()
  return doc || { key: 'default', rates: { ...DEFAULT_RATES }, updatedAt: null, updatedByName: '' }
}

export async function getRates() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache
  const doc = await getRatesDoc()
  const rates = { PKR: 1 }
  for (const c of CURRENCIES) {
    if (c === 'PKR') continue
    const v = Number(doc.rates?.[c])
    rates[c] = v > 0 ? v : DEFAULT_RATES[c]
  }
  cache = rates
  cachedAt = Date.now()
  return rates
}

export function clearRatesCache() { cache = null }

export const toPKRWith = (rates) => (amount, cur) => (amount || 0) * (rates[cur || 'PKR'] || 1)

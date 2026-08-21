/**
 * Assessment scoring — turns the free-form template responses into a percentage
 * per field and an overall percentage for the record.
 *
 * The record modal only captures raw responses, so nothing computed a score and
 * every assessment stored `overallScore: null` (reports/progress showed "—").
 * Scoring rules, by template field type:
 *   - scale   → 1..10 slider, score = value * 10
 *   - rating  → options are ordered worst → best, score = index / (n-1) * 100
 *   - select  → same as rating
 *   - number  → numeric value clamped to 0..100 (already a percentage)
 *   - text    → not scoreable, ignored
 * The overall score is the mean of the scoreable fields, rounded.
 */

function fieldsOf(template) {
  const map = new Map()
  for (const section of template?.sections || []) {
    for (const field of section.fields || []) {
      map.set(`${section.key}.${field.key}`, field)
      if (!map.has(field.key)) map.set(field.key, field)
    }
  }
  return map
}

/** Score one response value against its template field. Returns null if not scoreable. */
export function scoreResponse(field, value) {
  if (!field || value == null || value === '') return null
  const type = field.type

  if (type === 'scale') {
    const n = Number(value)
    if (!Number.isFinite(n)) return null
    return Math.max(0, Math.min(100, Math.round(n * 10)))
  }

  if (type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return null
    return Math.max(0, Math.min(100, Math.round(n)))
  }

  if (type === 'rating' || type === 'select') {
    const options = field.options || []
    // A numeric option ("8", "9/10") is a direct value; otherwise use its rank.
    const idx = options.indexOf(value)
    if (idx < 0) {
      const n = Number(value)
      return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n <= 10 ? n * 10 : n))) : null
    }
    if (options.length < 2) return 100
    return Math.round((idx / (options.length - 1)) * 100)
  }

  return null
}

/**
 * Attach a `score` to every scoreable response and return
 * `{ responses, overallScore }`. `overallScore` is null when nothing scored.
 */
export function scoreAssessment(template, responses = []) {
  const fields = fieldsOf(template)
  const scored = responses.map(r => {
    const field = fields.get(r.key)
    const score = scoreResponse(field, r.value)
    return score == null ? { ...r, score: undefined } : { ...r, score }
  })
  const nums = scored.map(r => r.score).filter(n => typeof n === 'number')
  return {
    responses: scored,
    overallScore: nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null,
  }
}

/** Human label + score list for a stored assessment — used by reports. */
export function assessmentBreakdown(template, responses = []) {
  const fields = fieldsOf(template)
  return responses.map(r => {
    const field = fields.get(r.key)
    return {
      key: r.key,
      label: field?.label || r.key,
      value: r.value,
      score: typeof r.score === 'number' ? r.score : scoreResponse(field, r.value),
    }
  })
}

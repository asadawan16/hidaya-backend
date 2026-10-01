/**
 * Assessment scoring — turns the free-form template responses into a percentage
 * per field and an overall percentage for the record.
 *
 * The record modal only captures raw responses, so nothing computed a score and
 * every assessment stored `overallScore: null` (reports/progress showed "—").
 * Scoring rules, by template field type:
 *   - scale   → 1..10 slider, score = value * 10
 *   - rating  → each option carries its own % (see `optionScore` below)
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

/*
 * What an answer is worth. Set per option in the template editor and stored as
 * `field.optionScores` — parallel to `field.options`, where a number is the %
 * and `null` means "no %": the question is left out of the average, as for
 * "Not learnt yet", where marking a student down for a lesson they haven't
 * reached yet would be wrong.
 *
 * An option with no stored score falls back to the academy's standard scale by
 * its label, and only an option that isn't on that scale falls back to rank.
 * Rank alone is what scored "Yes, No, Sometimes" as 0 / 50 / 100: it assumes
 * the options were typed worst → best, and nobody types them that way.
 */
export const EXCLUDED = null

const STANDARD_SCALE = new Map([
  ['yes', 100],
  ['mostofthetimes', 70],
  ['sometimes', 50],
  ['no', 0],
  ['notlearntyet', EXCLUDED],
])

// "Some times", "Sometime", "Most of the time", "Not learned yet" all mean the same answer.
const ALIASES = new Map([
  ['sometime', 'sometimes'],
  ['mostofthetime', 'mostofthetimes'],
  ['mostly', 'mostofthetimes'],
  ['notlearnedyet', 'notlearntyet'],
  ['notlearnt', 'notlearntyet'],
  ['notlearned', 'notlearntyet'],
])

function norm(label) {
  const k = String(label ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return ALIASES.get(k) || k
}

function rankScore(idx, n) {
  return n < 2 ? 100 : Math.round((idx / (n - 1)) * 100)
}

/**
 * The % each option of a rating/select field is worth, in option order —
 * the stored value where there is one, otherwise the default. `null` = no %.
 */
export function effectiveOptionScores(field) {
  const options = field?.options || []
  const stored = field?.optionScores || []
  return options.map((opt, i) => {
    const s = stored[i]
    if (s === null || typeof s === 'number') return s
    const std = STANDARD_SCALE.get(norm(opt))
    return std !== undefined ? std : rankScore(i, options.length)
  })
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
    let idx = options.indexOf(value)
    // An option renamed since the answer was recorded ("Sometime" → "Sometimes").
    if (idx < 0) idx = options.findIndex(o => norm(o) === norm(value))
    if (idx >= 0) return effectiveOptionScores(field)[idx]

    const std = STANDARD_SCALE.get(norm(value))
    if (std !== undefined) return std
    // A numeric answer ("8", "9/10") is a direct value.
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n <= 10 ? n * 10 : n))) : null
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

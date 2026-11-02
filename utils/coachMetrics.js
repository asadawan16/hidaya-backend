/*
 * English Coach — speaking measurements.
 *
 * Fluency is MEASURED, not guessed: every number here comes from Whisper's word
 * timings, so the same recording always gets the same figures. The examiner
 * model is shown these numbers but never decides them.
 *
 * All functions are pure (no I/O) — scripts/smoke-english-coach.mjs tests them
 * directly.
 */

export const LONG_PAUSE_SEC = 1.0

// Hesitation sounds only. Discourse words ("like", "basically", "you know")
// are left alone: counting them would flag perfectly good English.
const FILLERS = new Set([
  'um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'err', 'ah', 'ahh',
  'hmm', 'hmmm', 'mm', 'mmm', 'eh',
])

// What Whisper is known to "hear" in silence or noise. A turn that is only
// this, with a high no-speech probability, is treated as no speech at all.
const SILENCE_HALLUCINATIONS = new Set([
  'thank you', 'thank you very much', 'thanks for watching', 'thanks for watching!',
  'thank you for watching', 'bye', 'you', 'okay', 'so', '.', '...',
])

const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

export function normalizeWord(w) {
  return String(w || '').toLowerCase().replace(/[^a-z0-9']+/g, '').replace(/^'+|'+$/g, '')
}

export function isFiller(w) {
  return FILLERS.has(normalizeWord(w))
}

/** Lower-case, no punctuation, single spaces — for comparing sentences. */
export function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9'\s]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Measure one recorded turn.
 * @param {object} t  Whisper verbose_json: { text, words:[{word,start,end}], segments:[{avg_logprob,no_speech_prob}], duration }
 * @param {number} responseDelayMs  the character finished speaking → recording started (from the browser)
 */
export function turnMetrics(t, responseDelayMs = 0) {
  const text = String(t?.text || '').trim()
  const words = (Array.isArray(t?.words) ? t.words : [])
    .filter(w => normalizeWord(w.word) && Number.isFinite(w.start) && Number.isFinite(w.end))
  const segments = Array.isArray(t?.segments) ? t.segments : []

  const spoken = words.filter(w => !isFiller(w.word))
  const fillers = words.filter(w => isFiller(w.word)).map(w => normalizeWord(w.word))

  let longPauses = 0
  let longestPause = 0
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end
    if (gap > longestPause) longestPause = gap
    if (gap > LONG_PAUSE_SEC) longPauses++
  }

  const speakingSec = words.length ? Math.max(0, words[words.length - 1].end - words[0].start) : 0
  const leadingSilenceSec = words.length ? Math.max(0, words[0].start) : 0

  const logprobs = segments.map(s => s.avg_logprob).filter(Number.isFinite)
  const noSpeechProbs = segments.map(s => s.no_speech_prob).filter(Number.isFinite)
  const confidence = logprobs.length ? logprobs.reduce((a, b) => a + b, 0) / logprobs.length : null
  const noSpeechProb = noSpeechProbs.length ? noSpeechProbs.reduce((a, b) => a + b, 0) / noSpeechProbs.length : 0

  // Words from the text when the provider sent no word timings
  const wordCount = words.length ? spoken.length : text.split(/\s+/).filter(w => normalizeWord(w) && !isFiller(w)).length

  const noSpeech = !text
    || wordCount === 0
    || (noSpeechProb > 0.6 && SILENCE_HALLUCINATIONS.has(normalizeText(text)))
    || (noSpeechProb > 0.85 && wordCount <= 2)

  return {
    noSpeech,
    text,
    metrics: {
      audioSec: round(Number(t?.duration) || 0, 2),
      speakingSec: round(speakingSec, 2),
      leadingSilenceSec: round(leadingSilenceSec, 2),
      wordCount,
      fillerCount: fillers.length,
      fillers: fillers.slice(0, 30),
      longPauses,
      longestPauseSec: round(longestPause, 2),
      responseDelayMs: Math.round(clamp(Number(responseDelayMs) || 0, 0, 60_000)),
      confidence: round(confidence, 3),
      lowConfidence: (confidence != null && confidence < -0.9) || noSpeechProb > 0.6,
      hasTimings: words.length > 0,
    },
    spokenWords: spoken.map(w => normalizeWord(w.word)),
  }
}

/** Moving-average type-token ratio — vocabulary range that doesn't punish long answers. */
export function mattr(tokens, window = 40) {
  const toks = tokens.filter(Boolean)
  if (toks.length === 0) return null
  if (toks.length <= window) return new Set(toks).size / toks.length
  const counts = new Map()
  let distinct = 0
  for (let i = 0; i < window; i++) {
    const n = (counts.get(toks[i]) || 0) + 1
    counts.set(toks[i], n)
    if (n === 1) distinct++
  }
  let sum = distinct / window
  let windows = 1
  for (let i = window; i < toks.length; i++) {
    const out = toks[i - window]
    const o = counts.get(out) - 1
    counts.set(out, o)
    if (o === 0) distinct--
    const n = (counts.get(toks[i]) || 0) + 1
    counts.set(toks[i], n)
    if (n === 1) distinct++
    sum += distinct / window
    windows++
  }
  return sum / windows
}

/**
 * Whole-call measurements from the tester's turns.
 * @param {Array} turns  CoachSession.turns
 * @param {string[]} tokens  every spoken (non-filler) word of the tester, in order
 */
export function sessionMetrics(turns, tokens = []) {
  const tester = turns.filter(t => t.role === 'tester' && t.metrics)
  const sum = (f) => tester.reduce((a, t) => a + (Number(f(t.metrics)) || 0), 0)

  const wordCount = sum(m => m.wordCount)
  const timed = tester.filter(t => t.metrics.speakingSec > 0 && t.metrics.wordCount >= 3)
  const timedSec = timed.reduce((a, t) => a + t.metrics.speakingSec, 0)
  const timedWords = timed.reduce((a, t) => a + t.metrics.wordCount, 0)
  const speakingSec = sum(m => m.speakingSec)
  const minutes = speakingSec / 60

  const responses = tester.map(t => {
    const delay = clamp((t.metrics.responseDelayMs || 0) / 1000, 0, 30)
    const lead = clamp((t.metrics.leadingSilenceSec || 0) - 0.3, 0, 10)
    return delay + lead
  })

  // Words from the turn text when no word timings came back
  const toks = tokens.length ? tokens : tester.flatMap(t => normalizeText(t.text).split(' ')).filter(w => w && !FILLERS.has(w))
  const div = mattr(toks)

  return {
    speakingSec: round(speakingSec, 1),
    wordCount,
    wpm: timedSec >= 10 ? Math.round(timedWords / (timedSec / 60)) : null,
    longPauses: sum(m => m.longPauses),
    longPausesPerMin: minutes >= 0.25 ? round(sum(m => m.longPauses) / minutes, 2) : null,
    fillerCount: sum(m => m.fillerCount),
    fillersPerMin: minutes >= 0.25 ? round(sum(m => m.fillerCount) / minutes, 2) : null,
    avgResponseSec: responses.length ? round(responses.reduce((a, b) => a + b, 0) / responses.length, 1) : null,
    lexicalDiversity: div == null ? null : round(div, 3),
    avgTurnWords: tester.length ? round(wordCount / tester.length, 1) : 0,
    lowConfidenceTurns: tester.filter(t => t.metrics.lowConfidence).length,
  }
}

/** Piecewise-linear lookup through [[x, score], …] (x ascending), clamped at both ends. */
export function curve(x, points) {
  if (x == null || !Number.isFinite(x)) return null
  if (x <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]
    const [x0, y0] = points[i - 1]
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
  }
  return points[points.length - 1][1]
}

// The curves follow how spoken fluency is judged in IELTS / CEFR speaking
// assessment: natural conversation runs at roughly 120–165 words a minute;
// noticeable hesitation ("um", "uh") and long pauses mark a speaker as
// searching for language; one-line answers show no extended speech.
// They are deliberately strict below the comfortable range and flat inside it,
// so a fluent speaker is never marked down.
const WPM = [[60, 10], [80, 35], [100, 65], [115, 85], [125, 100], [170, 100], [190, 85], [215, 60], [240, 35]]
const FILLERS_PER_MIN = [[0, 100], [1, 100], [2, 90], [3, 75], [4, 60], [6, 40], [8, 25], [12, 10]]
const PAUSES_PER_MIN = [[0, 100], [1, 95], [2, 80], [3, 62], [4, 48], [6, 28], [9, 10]]
const RESPONSE_SEC = [[0, 100], [1.5, 100], [3, 82], [5, 60], [8, 35], [12, 15]]
const TURN_WORDS = [[3, 10], [6, 30], [10, 55], [15, 75], [22, 92], [30, 100]]
const DIVERSITY = [[0.45, 30], [0.55, 55], [0.65, 78], [0.72, 92], [0.78, 100]]

/**
 * Measured fluency 0–100 (speed, hesitations, pauses, response time, length of
 * answers), or null when there is too little timed speech to judge (under 20 s).
 * The examiner's own fluency-and-coherence mark is blended in afterwards
 * (services/coachExaminer.js) — numbers can't hear rambling or vagueness.
 */
export function fluencyScore(m) {
  if (!m || !(m.speakingSec >= 20) || m.wpm == null) return null
  const parts = [
    [curve(m.wpm, WPM), 0.25],
    [curve(m.fillersPerMin, FILLERS_PER_MIN), 0.25],
    [curve(m.longPausesPerMin, PAUSES_PER_MIN), 0.2],
    [curve(m.avgResponseSec, RESPONSE_SEC), 0.1],
    [curve(m.avgTurnWords, TURN_WORDS), 0.2],
  ].filter(([v]) => v != null)
  const w = parts.reduce((a, [, wt]) => a + wt, 0)
  if (!w) return null
  return Math.round(parts.reduce((a, [v, wt]) => a + v * wt, 0) / w)
}

/** Vocabulary range 0–100 from lexical diversity, or null. */
export function diversityScore(m) {
  if (!m || m.lexicalDiversity == null || m.wordCount < 30) return null
  return Math.round(curve(m.lexicalDiversity, DIVERSITY))
}

export const AREA_WEIGHTS = {
  fluency: 0.2, grammar: 0.2, vocabulary: 0.15, professionalism: 0.15, clarity: 0.15, handling: 0.15,
}

/**
 * The overall, as workplace speaking tests treat it: a weighted average of the
 * six areas, then two gates —
 *   - task achievement: you can't score far above how well you handled the call
 *     (handling + 15)
 *   - weakest link: one seriously weak area holds the total back (lowest + 30)
 * A strong call has no weak area and handles the task, so neither gate touches it.
 * An area with no score is left out and the rest re-weighted.
 */
export function overallScore(scores) {
  let total = 0
  let weight = 0
  const present = []
  for (const [k, w] of Object.entries(AREA_WEIGHTS)) {
    const v = scores?.[k]
    if (Number.isFinite(v)) { total += v * w; weight += w; present.push(v) }
  }
  if (!weight) return null
  let overall = total / weight
  if (Number.isFinite(scores?.handling)) overall = Math.min(overall, scores.handling + 15)
  overall = Math.min(overall, Math.min(...present) + 30)
  return Math.round(overall)
}

// Roughly: excellent ≈ CEFR C1+, good ≈ B2, developing ≈ B1, needs work ≈ A2 or below
export function bandFor(score) {
  if (!Number.isFinite(score)) return null
  if (score >= 85) return 'excellent'
  if (score >= 70) return 'good'
  if (score >= 50) return 'developing'
  return 'needs_work'
}

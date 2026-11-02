/*
 * English Coach — the AI providers.
 *
 * Four free models, two providers, all over plain HTTPS (no SDKs):
 *   listen    Whisper large-v3-turbo        Groq    (word timings → fluency)
 *   act       Llama 3.3 70B                 Groq    → Gemini Flash-Lite if Groq is unavailable
 *   examine   Gemini 2.5 Flash              Google  → Llama 3.3 70B if Gemini is unavailable
 *   speak     Kokoro 82M                    in the tester's browser (not here)
 * The character and the examiner are deliberately different models from
 * different companies: the AI that played the parent is not the one marking.
 *
 * Both providers speak the OpenAI chat-completions dialect, so switching is a
 * base URL + key + model name. Free plans cap requests per minute and per day;
 * a 429 puts that provider on a cooldown (Retry-After, or longer for a daily
 * cap) and the next call goes straight to the other one instead of waiting.
 * Cooldowns are in memory: a restart simply tries again.
 *
 * Env: GROQ_API_KEY (required — Whisper only runs there), GEMINI_API_KEY
 * (recommended — the examiner and the backup character). Model names can be
 * overridden with COACH_STT_MODEL, COACH_GROQ_MODEL, COACH_GEMINI_ACTOR_MODEL,
 * COACH_GEMINI_EXAMINER_MODEL without a code change.
 */

// Overridable for a proxy or a local stand-in (end-to-end tests)
const GROQ_BASE = process.env.COACH_GROQ_BASE_URL || 'https://api.groq.com/openai/v1'
const GEMINI_BASE = process.env.COACH_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai'

const STT_TIMEOUT_MS = 45_000
const CHAT_TIMEOUT_MS = { actor: 20_000, examiner: 60_000 }

// Biases Whisper towards keeping hesitations, so fillers can be counted.
// Without it Whisper tidies "um, so, uh" into clean prose.
const FILLER_PROMPT = 'Umm, let me think, uh... so, hmm, I mean, okay. Er, well, um, yes.'

export function coachModels() {
  return {
    stt: process.env.COACH_STT_MODEL || 'whisper-large-v3-turbo',
    groqChat: process.env.COACH_GROQ_MODEL || 'llama-3.3-70b-versatile',
    geminiActor: process.env.COACH_GEMINI_ACTOR_MODEL || 'gemini-2.5-flash-lite',
    geminiExaminer: process.env.COACH_GEMINI_EXAMINER_MODEL || 'gemini-2.5-flash',
  }
}

const keyFor = (p) => (p === 'groq' ? process.env.GROQ_API_KEY : process.env.GEMINI_API_KEY) || ''

export class CoachAiError extends Error {
  /**
   * @param {'not_configured'|'rate_limited'|'unavailable'|'bad_audio'|'bad_response'} code
   */
  constructor(code, message, { retryAfterSec, provider } = {}) {
    super(message)
    this.code = code
    this.retryAfterSec = retryAfterSec
    this.provider = provider
  }
}

// ── Provider health (in memory) ──────────────────────────────────────────────
const health = {
  groq: { cooldownUntil: 0, lastError: '', lastErrorAt: null, lastOkAt: null },
  gemini: { cooldownUntil: 0, lastError: '', lastErrorAt: null, lastOkAt: null },
}

function markOk(p) { health[p].lastOkAt = new Date() }
function markError(p, message, cooldownSec = 0) {
  health[p].lastError = String(message || '').slice(0, 300)
  health[p].lastErrorAt = new Date()
  if (cooldownSec > 0) health[p].cooldownUntil = Math.max(health[p].cooldownUntil, Date.now() + cooldownSec * 1000)
}
const coolingSec = (p) => Math.max(0, Math.ceil((health[p].cooldownUntil - Date.now()) / 1000))

/** Test hook: forget cooldowns and errors. */
export function resetCoachAiHealth() {
  for (const p of Object.keys(health)) Object.assign(health[p], { cooldownUntil: 0, lastError: '', lastErrorAt: null, lastOkAt: null })
}

/** How long to stay off a provider after a 429. Daily caps get a long rest. */
function rateLimitCooldown(res, message) {
  const header = Number(res?.headers?.get?.('retry-after'))
  if (Number.isFinite(header) && header > 0) return Math.min(header, 3600)
  if (/per day|daily|TPD|RPD|PerDay/i.test(message)) return 30 * 60
  // Groq: "Please try again in 1m2.5s" / "in 7.66s"
  const m = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(message)
  if (m) return Math.ceil((Number(m[1]) || 0) * 60 + Number(m[2]))
  return 60
}

async function readError(res) {
  try {
    const body = await res.json()
    const e = Array.isArray(body) ? body[0]?.error : body?.error
    return e?.message || JSON.stringify(body).slice(0, 300)
  } catch {
    return `HTTP ${res.status}`
  }
}

/** Turn a failed fetch (thrown or non-2xx) into a CoachAiError and update health. */
async function failure(provider, resOrErr) {
  if (!(resOrErr instanceof Response)) {
    const timeout = resOrErr?.name === 'TimeoutError' || resOrErr?.name === 'AbortError'
    const msg = timeout ? 'timed out' : (resOrErr?.message || 'network error')
    markError(provider, msg, 20)
    return new CoachAiError('unavailable', `${provider}: ${msg}`, { provider })
  }
  const res = resOrErr
  const msg = await readError(res)
  if (res.status === 429) {
    const sec = rateLimitCooldown(res, msg)
    markError(provider, `rate limited: ${msg}`, sec)
    return new CoachAiError('rate_limited', `${provider}: ${msg}`, { retryAfterSec: sec, provider })
  }
  if (res.status === 401 || res.status === 403) {
    markError(provider, `key rejected: ${msg}`, 600)
    return new CoachAiError('not_configured', `${provider}: ${msg}`, { provider })
  }
  if (res.status === 400 || res.status === 413 || res.status === 422) {
    markError(provider, msg)
    return new CoachAiError('bad_response', `${provider}: ${msg}`, { provider, status: res.status })
  }
  markError(provider, msg, 20)
  return new CoachAiError('unavailable', `${provider}: ${msg}`, { provider })
}

// ── Speech to text ───────────────────────────────────────────────────────────
const EXT = {
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'video/mp4': 'mp4',
  'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac',
}
export const ACCEPTED_AUDIO = Object.keys(EXT)

export function audioExtension(mimeType) {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase()
  return EXT[base] || null
}

/**
 * Transcribe one recorded turn with word timings.
 * @returns Whisper verbose_json { text, words, segments, duration }
 */
export async function transcribe(buffer, mimeType) {
  const key = keyFor('groq')
  if (!key) throw new CoachAiError('not_configured', 'GROQ_API_KEY is not set', { provider: 'groq' })
  const ext = audioExtension(mimeType)
  if (!ext) throw new CoachAiError('bad_audio', `Unsupported audio type ${mimeType}`)
  const wait = coolingSec('groq')
  if (wait) throw new CoachAiError('rate_limited', 'Speech recognition is busy', { retryAfterSec: wait, provider: 'groq' })

  const form = new FormData()
  form.append('file', new Blob([buffer], { type: String(mimeType).split(';')[0] }), `turn.${ext}`)
  form.append('model', coachModels().stt)
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')
  form.append('timestamp_granularities[]', 'segment')
  form.append('language', 'en')
  form.append('temperature', '0')
  form.append('prompt', FILLER_PROMPT)

  let res
  try {
    res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    })
  } catch (err) {
    throw await failure('groq', err)
  }
  if (!res.ok) {
    const err = await failure('groq', res)
    // A 400 here is the file itself (empty, corrupt, too short) — not the provider
    if (err.code === 'bad_response') throw new CoachAiError('bad_audio', err.message, { provider: 'groq' })
    throw err
  }
  markOk('groq')
  return res.json()
}

// ── Chat ─────────────────────────────────────────────────────────────────────
function chainFor(purpose) {
  const m = coachModels()
  return purpose === 'examiner'
    ? [{ provider: 'gemini', model: m.geminiExaminer }, { provider: 'groq', model: m.groqChat }]
    : [{ provider: 'groq', model: m.groqChat }, { provider: 'gemini', model: m.geminiActor }]
}

function requestBody({ provider, model }, { purpose, messages, temperature, maxTokens, jsonSchema }, withFormat = true) {
  const body = { model, messages, temperature, max_tokens: maxTokens }
  if (provider === 'gemini' && /2\.5/.test(model)) {
    // Thinking off for the character (speed); a little for the examiner
    body.reasoning_effort = purpose === 'examiner' ? 'low' : 'none'
  }
  if (jsonSchema && withFormat) {
    body.response_format = provider === 'gemini'
      ? { type: 'json_schema', json_schema: { name: 'scorecard', schema: jsonSchema } }
      : { type: 'json_object' }
  }
  return body
}

async function callOnce(target, opts, withFormat) {
  const { provider } = target
  let res
  try {
    res = await fetch(`${provider === 'groq' ? GROQ_BASE : GEMINI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyFor(provider)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(target, opts, withFormat)),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS[opts.purpose] || 30_000),
    })
  } catch (err) {
    throw await failure(provider, err)
  }
  if (!res.ok) throw await failure(provider, res)
  const data = await res.json()
  const choice = data?.choices?.[0]
  const text = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : ''
  if (!text) {
    markError(provider, `empty reply (finish_reason: ${choice?.finish_reason || 'none'})`)
    throw new CoachAiError('bad_response', `${provider}: empty reply`, { provider })
  }
  markOk(provider)
  return {
    text,
    provider,
    model: target.model,
    finishReason: choice?.finish_reason || '',
    usage: { promptTokens: data?.usage?.prompt_tokens || 0, completionTokens: data?.usage?.completion_tokens || 0 },
  }
}

/**
 * One chat completion, trying each provider in turn.
 * @param {{purpose:'actor'|'examiner', messages:Array, temperature?:number, maxTokens?:number, jsonSchema?:object, skip?:string[]}} opts
 *   `skip` — providers not to use this time (e.g. one whose reply was unusable)
 */
export async function chat(opts) {
  const o = { temperature: 0.7, maxTokens: 300, ...opts }
  const targets = chainFor(o.purpose).filter(t => keyFor(t.provider) && !(o.skip || []).includes(t.provider))
  if (!targets.length) throw new CoachAiError('not_configured', 'No AI provider key is set for this step')

  let lastErr = null
  let soonest = Infinity
  for (const target of targets) {
    const wait = coolingSec(target.provider)
    if (wait) { soonest = Math.min(soonest, wait); continue }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callOnce(target, o, true)
      } catch (err) {
        lastErr = err
        // Gemini refusing the schema itself: same call without a response format
        if (err.code === 'bad_response' && o.jsonSchema && target.provider === 'gemini' && attempt === 0) {
          try { return await callOnce(target, o, false) } catch (e2) { lastErr = e2 }
          break
        }
        if (err.code === 'unavailable' && attempt === 0) {
          health[target.provider].cooldownUntil = 0 // one quick retry before moving on
          await new Promise(r => setTimeout(r, 600))
          continue
        }
        break
      }
    }
    if (lastErr?.code === 'rate_limited') soonest = Math.min(soonest, lastErr.retryAfterSec || 60)
  }
  // Every provider was resting, or the last one said "too many requests"
  if (!lastErr || lastErr.code === 'rate_limited') {
    throw new CoachAiError('rate_limited', 'The free AI allowance is used up for now', {
      retryAfterSec: Number.isFinite(soonest) ? soonest : 60,
    })
  }
  if (Number.isFinite(soonest)) lastErr.retryAfterSec = soonest
  throw lastErr
}

/** Which steps can run right now — for the Settings tab and the tester's start screen. */
export function coachAiStatus() {
  const groq = Boolean(keyFor('groq'))
  const gemini = Boolean(keyFor('gemini'))
  const view = (p, configured) => ({
    configured,
    coolingDownSec: coolingSec(p),
    lastError: health[p].lastError,
    lastErrorAt: health[p].lastErrorAt,
    lastOkAt: health[p].lastOkAt,
  })
  return {
    ready: groq, // Whisper needs Groq; with Groq alone every step still runs
    examinerIndependent: gemini, // the examiner is a different company's model only when Gemini is set
    providers: { groq: view('groq', groq), gemini: view('gemini', gemini) },
    models: coachModels(),
  }
}

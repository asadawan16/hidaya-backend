/*
 * English Coach — the AI providers.
 *
 * Free models from two providers, all over plain HTTPS (no SDKs):
 *   listen    Whisper large-v3-turbo        Groq    (word timings → fluency)
 *   act       GPT-OSS 120B (open weights)   Groq    → Gemini Flash-Lite
 *   examine   Gemini Flash                  Google  → GPT-OSS on Groq
 *   speak     Kokoro 82M                    in the tester's browser (not here)
 * The character and the examiner are deliberately from different companies:
 * the AI that played the parent is not the one marking.
 *
 * Both providers speak the OpenAI chat-completions dialect. Each step has a
 * RANKED LIST of models rather than one, because free models come and go
 * (Groq retired Llama 3.3; Google closed Gemini 2.5 to new keys in late 2026):
 *   - a model the provider says is gone is skipped for 6 hours, so a
 *     retirement never takes the coach down
 *   - a 429 rests that MODEL (free quotas are per model on both providers) for
 *     its Retry-After, or 30 min for a daily cap, and the next model is tried
 *   - an overloaded / failing model rests briefly and the next one is tried
 *   - each step has a time budget, so a slow model can't stall a live call
 * State is in memory: a restart simply tries everything again.
 *
 * KEYS: each provider can have several (GROQ_API_KEYS / GEMINI_API_KEYS,
 * comma-separated, alongside GROQ_API_KEY / GEMINI_API_KEY). The first key is
 * used until it is out of quota or rejected, then the next — limits are tracked
 * per key AND per model, so one exhausted key never blocks the others.
 *
 * Env: GROQ_API_KEY(S) (required — Whisper only runs there), GEMINI_API_KEY(S)
 * (recommended — the examiner and the backup character). Put your own model
 * first with COACH_GROQ_MODEL, COACH_GEMINI_ACTOR_MODEL,
 * COACH_GEMINI_EXAMINER_MODEL (comma-separated lists allowed) or COACH_STT_MODEL.
 */

// Overridable for a proxy or a local stand-in (end-to-end tests)
const GROQ_BASE = process.env.COACH_GROQ_BASE_URL || 'https://api.groq.com/openai/v1'
const GEMINI_BASE = process.env.COACH_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai'

const STT_TIMEOUT_MS = 45_000
// A healthy reply takes 1–2 s (character) or ~5 s (examiner); an overloaded
// model can hang far longer, and the next one in the list is the better bet.
const CALL_TIMEOUT_MS = { actor: 12_000, examiner: 25_000 }
const BUDGET_MS = { actor: 30_000, examiner: 120_000 }
const GONE_FOR_MS = 6 * 60 * 60_000

// Biases Whisper towards keeping hesitations, so fillers can be counted.
// Without it Whisper tidies "um, so, uh" into clean prose.
const FILLER_PROMPT = 'Umm, let me think, uh... so, hmm, I mean, okay. Er, well, um, yes.'

const list = (env, defaults) => [...new Set([...String(env || '').split(',').map(s => s.trim()).filter(Boolean), ...defaults])]

/** The ranked model lists (env overrides go first). */
export function coachModels() {
  return {
    stt: process.env.COACH_STT_MODEL || 'whisper-large-v3-turbo',
    groqChat: list(process.env.COACH_GROQ_MODEL, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']),
    geminiActor: list(process.env.COACH_GEMINI_ACTOR_MODEL, ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']),
    geminiExaminer: list(process.env.COACH_GEMINI_EXAMINER_MODEL, ['gemini-3.6-flash', 'gemini-3.8-flash']),
  }
}

/** Every key for a provider, in order: GROQ_API_KEYS (comma list) then GROQ_API_KEY. */
export function keysFor(p) {
  const many = p === 'groq' ? process.env.GROQ_API_KEYS : process.env.GEMINI_API_KEYS
  const one = p === 'groq' ? process.env.GROQ_API_KEY : process.env.GEMINI_API_KEY
  return [...new Set([...String(many || '').split(','), String(one || '')].map(k => k.trim()).filter(Boolean))]
}
const hasKey = (p) => keysFor(p).length > 0

export class CoachAiError extends Error {
  /**
   * @param {'not_configured'|'rate_limited'|'unavailable'|'bad_audio'|'bad_response'|'model_gone'} code
   */
  constructor(code, message, { retryAfterSec, provider } = {}) {
    super(message)
    this.code = code
    this.retryAfterSec = retryAfterSec
    this.provider = provider
  }
}

// ── Health (in memory) ───────────────────────────────────────────────────────
// A target is one model reached with one key: { provider, model, key, ki }.
//   per provider       — what the Settings tab shows
//   per key            — a rejected key rests 10 min; Whisper's quota (per key)
//   per key + model    — 429 / overload rests (free quotas are per model, per key)
//   per model          — retirement ("no longer available"), whichever key saw it
const health = {
  groq: { lastError: '', lastErrorAt: null, lastOkAt: null },
  gemini: { lastError: '', lastErrorAt: null, lastOkAt: null },
}
const rests = new Map()   // 'provider/model#ki' | 'provider#ki' | 'provider#ki/stt' → until (ms)
const retired = new Map() // 'provider/model' → until (ms)

const secsUntil = (ms) => Math.max(0, Math.ceil(((ms || 0) - Date.now()) / 1000))
const restKey = (t) => (t.model ? `${t.provider}/${t.model}#${t.ki}` : `${t.provider}#${t.ki}/stt`)
const keyRestKey = (t) => `${t.provider}#${t.ki}`
const rest = (k, sec) => rests.set(k, Math.max(rests.get(k) || 0, Date.now() + sec * 1000))
const isGone = (t) => (retired.get(`${t.provider}/${t.model}`) || 0) > Date.now()
const restingSec = (t) => Math.max(secsUntil(rests.get(restKey(t))), secsUntil(rests.get(keyRestKey(t))))
const tkey = (t) => `${t.provider}/${t.model}`

function markOk(p) { health[p].lastOkAt = new Date() }
function markError(p, message) {
  health[p].lastError = String(message || '').slice(0, 300)
  health[p].lastErrorAt = new Date()
}

/** Test hook: forget every rest, retirement and error. */
export function resetCoachAiHealth() {
  for (const p of Object.keys(health)) Object.assign(health[p], { lastError: '', lastErrorAt: null, lastOkAt: null })
  rests.clear()
  retired.clear()
}

/** How long to rest after a 429. Daily caps get a long rest. */
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

const MODEL_GONE = /(does not exist|not found|no longer available|decommission|deprecated|not available to new users)/i

/**
 * Turn a failed fetch (thrown, or a non-2xx Response) into a CoachAiError and
 * record what it means for that provider / model.
 * @param {{provider:string, model?:string, ki:number}} t  (no model = speech-to-text)
 */
async function failure(t, resOrErr) {
  const { provider } = t
  if (!(resOrErr instanceof Response)) {
    const timeout = resOrErr?.name === 'TimeoutError' || resOrErr?.name === 'AbortError'
    const msg = timeout ? `${t.model || 'request'} timed out` : (resOrErr?.message || 'network error')
    markError(provider, msg)
    rest(restKey(t), 20)
    return new CoachAiError('unavailable', `${provider}: ${msg}`, { provider })
  }
  const res = resOrErr
  const msg = await readError(res)
  if (res.status === 429) {
    const sec = rateLimitCooldown(res, msg)
    markError(provider, `${t.model || 'speech-to-text'} (key ${t.ki + 1}) rate limited: ${msg}`)
    rest(restKey(t), sec)
    return new CoachAiError('rate_limited', `${provider}: ${msg}`, { retryAfterSec: sec, provider })
  }
  if (res.status === 401 || res.status === 403) {
    markError(provider, `key ${t.ki + 1} rejected: ${msg}`)
    rest(keyRestKey(t), 600)
    return new CoachAiError('not_configured', `${provider}: ${msg}`, { provider })
  }
  if (t.model && (res.status === 404 || res.status === 400) && /model/i.test(msg) && MODEL_GONE.test(msg)) {
    markError(provider, `${t.model} unavailable: ${msg}`)
    retired.set(tkey(t), Date.now() + GONE_FOR_MS)
    return new CoachAiError('model_gone', `${provider}: ${msg}`, { provider })
  }
  if (res.status === 400 || res.status === 413 || res.status === 422) {
    markError(provider, msg)
    return new CoachAiError('bad_response', `${provider}: ${msg}`, { provider })
  }
  // 5xx — overloaded or down: rest this model briefly, try the next
  markError(provider, `${t.model || 'request'}: ${msg}`)
  rest(restKey(t), 30)
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
 * Transcribe one recorded turn with word timings. Tries each Groq key in turn.
 * @returns Whisper verbose_json { text, words, segments, duration }
 */
export async function transcribe(buffer, mimeType) {
  const keys = keysFor('groq')
  if (!keys.length) throw new CoachAiError('not_configured', 'GROQ_API_KEY is not set', { provider: 'groq' })
  const ext = audioExtension(mimeType)
  if (!ext) throw new CoachAiError('bad_audio', `Unsupported audio type ${mimeType}`)

  let lastErr = null
  let soonest = Infinity
  for (let ki = 0; ki < keys.length; ki++) {
    const t = { provider: 'groq', key: keys[ki], ki } // no model: speech-to-text has its own limits per key
    const wait = restingSec(t)
    if (wait) { soonest = Math.min(soonest, wait); continue }
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
        method: 'POST', headers: { Authorization: `Bearer ${t.key}` }, body: form, signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      })
    } catch (err) {
      lastErr = await failure(t, err)
      continue
    }
    if (res.ok) { markOk('groq'); return res.json() }
    lastErr = await failure(t, res)
    // A 400 here is the file itself (empty, corrupt, too short) — another key won't help
    if (lastErr.code === 'bad_response') throw new CoachAiError('bad_audio', lastErr.message, { provider: 'groq' })
    if (lastErr.code === 'rate_limited') soonest = Math.min(soonest, lastErr.retryAfterSec || 60)
  }
  if (!lastErr || lastErr.code === 'rate_limited') {
    throw new CoachAiError('rate_limited', 'Speech recognition is busy', { retryAfterSec: Number.isFinite(soonest) ? soonest : 60, provider: 'groq' })
  }
  throw lastErr
}

// ── Chat ─────────────────────────────────────────────────────────────────────
/** Ranked targets for a step: each model, reached with each key in order. */
function chainFor(purpose) {
  const m = coachModels()
  const expand = (provider, names) => names.flatMap(model => keysFor(provider).map((key, ki) => ({ provider, model, key, ki })))
  return purpose === 'examiner'
    ? [...expand('gemini', m.geminiExaminer), ...expand('groq', m.groqChat)]
    : [...expand('groq', m.groqChat), ...expand('gemini', m.geminiActor)]
}

function requestBody({ provider, model }, { purpose, messages, temperature, maxTokens, jsonSchema }, withFormat = true) {
  const body = { model, messages, temperature, max_tokens: maxTokens }
  const examiner = purpose === 'examiner'
  if (provider === 'groq' && /gpt-oss/i.test(model)) {
    // A reasoning model: keep the thinking short, and leave room for it in the budget
    body.reasoning_effort = 'low'
    body.max_tokens = maxTokens + 1000
  }
  if (provider === 'gemini') {
    if (/2\.5/.test(model)) body.reasoning_effort = examiner ? 'low' : 'none'
    else if (/gemini-(3|flash|pro)/.test(model)) body.reasoning_effort = examiner ? 'low' : 'minimal'
  }
  if (jsonSchema && withFormat) {
    body.response_format = provider === 'gemini'
      ? { type: 'json_schema', json_schema: { name: 'scorecard', schema: jsonSchema } }
      : { type: 'json_object' }
  }
  return body
}

async function callOnce(target, opts, withFormat, timeoutMs) {
  const { provider } = target
  let res
  try {
    res = await fetch(`${provider === 'groq' ? GROQ_BASE : GEMINI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(target, opts, withFormat)),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw await failure(target, err)
  }
  if (!res.ok) throw await failure(target, res)
  const data = await res.json()
  const choice = data?.choices?.[0]
  const text = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : ''
  if (!text) {
    markError(provider, `${target.model}: empty reply (finish_reason: ${choice?.finish_reason || 'none'})`)
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
 * One chat completion, trying each model (and each key) in the step's ranked list.
 * @param {{purpose:'actor'|'examiner', messages:Array, temperature?:number, maxTokens?:number, jsonSchema?:object, skip?:string[]}} opts
 *   `skip` — providers not to use this time (e.g. one whose reply was unusable)
 */
export async function chat(opts) {
  const o = { temperature: 0.7, maxTokens: 300, ...opts }
  const targets = chainFor(o.purpose).filter(t => !(o.skip || []).includes(t.provider))
  if (!targets.length) throw new CoachAiError('not_configured', 'No AI provider key is set for this step')

  const started = Date.now()
  const budget = BUDGET_MS[o.purpose] || 60_000
  let lastErr = null
  let soonest = Infinity
  for (const target of targets) {
    const left = budget - (Date.now() - started)
    if (left < 3000) break
    if (isGone(target)) continue
    const wait = restingSec(target)
    if (wait) { soonest = Math.min(soonest, wait); continue }
    const timeout = Math.min(CALL_TIMEOUT_MS[o.purpose] || 30_000, left)
    try {
      return await callOnce(target, o, true, timeout)
    } catch (err) {
      lastErr = err
      // Gemini refusing the schema itself: same call without a response format
      if (err.code === 'bad_response' && o.jsonSchema && target.provider === 'gemini') {
        try { return await callOnce(target, o, false, timeout) } catch (e2) { lastErr = e2 }
      }
      if (lastErr.code === 'rate_limited') soonest = Math.min(soonest, lastErr.retryAfterSec || 60)
    }
  }
  // Every model resting, or the last one said "too many requests"
  if (!lastErr || lastErr.code === 'rate_limited') {
    throw new CoachAiError('rate_limited', 'The free AI allowance is used up for now', {
      retryAfterSec: Number.isFinite(soonest) ? soonest : 60,
    })
  }
  if (lastErr.code === 'model_gone') lastErr = new CoachAiError('unavailable', 'No AI model is available right now', { provider: lastErr.provider })
  if (Number.isFinite(soonest)) lastErr.retryAfterSec = soonest
  throw lastErr
}

/** Which steps can run right now — for the Settings tab and the tester's start screen. */
export function coachAiStatus() {
  const m = coachModels()
  const all = [...chainFor('actor'), ...chainFor('examiner')]
  const firstUsable = (provider, names) => names.find(model => !isGone({ provider, model })) || names[0]
  const view = (p) => {
    const keys = keysFor(p)
    const mine = all.filter(t => t.provider === p && !isGone(t))
    const resting = mine.length > 0 && mine.every(t => restingSec(t) > 0)
    return {
      configured: keys.length > 0,
      keys: keys.length,
      keysRejected: keys.filter((_, ki) => secsUntil(rests.get(keyRestKey({ provider: p, ki }))) > 0).length,
      coolingDownSec: resting ? Math.min(...mine.map(restingSec)) : 0,
      lastError: health[p].lastError,
      lastErrorAt: health[p].lastErrorAt,
      lastOkAt: health[p].lastOkAt,
    }
  }
  return {
    ready: hasKey('groq'), // Whisper needs Groq; with Groq alone every step still runs
    examinerIndependent: hasKey('gemini'), // the examiner is a different company's model only when Gemini is set
    providers: { groq: view('groq'), gemini: view('gemini') },
    models: {
      stt: m.stt,
      groqChat: firstUsable('groq', m.groqChat),
      geminiActor: firstUsable('gemini', m.geminiActor),
      geminiExaminer: firstUsable('gemini', m.geminiExaminer),
      unavailable: [...new Set(all.filter(isGone).map(tkey))],
    },
  }
}

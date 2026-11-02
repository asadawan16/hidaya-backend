// Smoke test for the English Coach (controllers/portalCoachController.js and
// the services/utils behind it).
//
// Covers:
//   - speaking measurements: fillers, long pauses, speaking rate, Whisper's
//     "Thank you." in silence, vocabulary variety, the fluency curve, the
//     weighted overall and bands
//   - the character: stage directions / labels / emoji stripped, a model that
//     says "as an AI" is replaced, the history window stays user-first
//   - the examiner: JSON in code fences, 0–10 answers rescaled, a missing area
//     rejected, invented quotes dropped, no-op corrections dropped
//   - providers: Groq → Gemini switch-over for the character on a 429, the
//     cooldown is honoured, Gemini → Groq for the examiner, no keys = not set up
//   - the call: consent, scenario/difficulty/length validation, one live call
//     per person, ownership, empty / unreadable audio, silence, a retried
//     upload returns the same reply, two answers at once, AI out of quota
//     (lock released, nothing saved), the 60-answer cap, time-up grace,
//     finishing while an answer is in flight
//   - marking: too short, scored with measured fluency + blended vocabulary,
//     a bad examiner answer retried on the other provider, quota exhaustion
//     waits instead of failing, three unusable answers → failed → rescore
//   - limits: per-person 24-hour cap (abandoned calls don't count) and the
//     academy-wide cap; settings validation; scenario switched off
//   - reviewers: list/filter, people, overview + calibration, can't review
//     your own test, notification to the tester; delete
//   - the sweeper closes a call whose tab was closed and marks it
//   - default role permissions
//
// AI providers are a stubbed global fetch. Runs against a THROWAWAY database
// (hidaya_english_coach_smoke) and drops it. No server or API keys needed.
// Run: node scripts/smoke-english-coach.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import User from '../models/User.js'
import Role from '../models/Role.js'
import Notification from '../models/Notification.js'
import CoachSession from '../models/CoachSession.js'
import CoachSettings from '../models/CoachSettings.js'
import { effectivePermissions } from '../middleware/portalAuth.js'
import { DEFAULT_ROLE_PERMISSIONS } from '../config/permissions.js'
import {
  turnMetrics, sessionMetrics, mattr, fluencyScore, overallScore, bandFor, diversityScore,
} from '../utils/coachMetrics.js'
import { cleanReply, historyMessages, personaReply, FALLBACK_LINES } from '../services/coachPersona.js'
import { parseJsonReply, validateVerdict } from '../services/coachExaminer.js'
import { chat, resetCoachAiHealth, coachAiStatus } from '../services/coachAi.js'
import {
  getConfig, startSession, addTurn, finishSession, listMine, getSession, rescoreSession,
  listSessions, listPeople, getOverview, reviewSession, deleteSession, getSettings, updateSettings,
  sweepCoachSessions, scoreSession, MAX_TESTER_TURNS,
} from '../controllers/portalCoachController.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.error('  ✗', m) } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await sleep(40) }
  return false
}

// ── Fake Whisper ─────────────────────────────────────────────────────────────
/** Whisper verbose_json for a sentence: 0.35 s words, 0.1 s gaps, optional long pauses. */
function stt(text, { start = 0.5, pausesAfter = [], noSpeechProb = 0.02, logprob = -0.25 } = {}) {
  let t = start
  const words = text.split(/\s+/).filter(Boolean).map((word, i) => {
    const w = { word, start: t, end: t + 0.35 }
    t = w.end + (pausesAfter.includes(i) ? 1.6 : 0.1)
    return w
  })
  return { text, duration: t + 0.3, words, segments: [{ avg_logprob: logprob, no_speech_prob: noSpeechProb }] }
}
const scripts = new Map() // audio "content" → Whisper answer
let sttMode = 'ok'
let sttDelayMs = 0
const audio = (key) => Buffer.from(`AUDIO:${key}:`.padEnd(2000, '.'))
const say = (key, text, opts) => { scripts.set(key, stt(text, opts)); return audio(key) }

// ── Fake chat providers ──────────────────────────────────────────────────────
const queues = { groq: [], gemini: [] }   // queued handlers, used before the default
const calls = { groq: [], gemini: [] }
const json = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const completion = (text) => json(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })

function verdictFor(prompt, extra = {}) {
  const testerLine = (prompt.match(/\] TESTER: (.+)/) || [])[1] || ''
  const quote = testerLine.split(/\s+/).slice(0, 6).join(' ')
  return JSON.stringify({
    scores: { grammar: 72, vocabulary: 70, professionalism: 85, clarity: 78, handling: 74 },
    reasons: { grammar: 'Mostly accurate.', vocabulary: 'Adequate.', professionalism: 'Polite.', clarity: 'Clear.', handling: 'Reassuring.' },
    summary: 'You were calm and polite.',
    strengths: ['Polite greeting'],
    improvements: ['Use past tense consistently', 'Give specific examples', 'Summarise next steps'],
    corrections: [
      { original: quote, corrected: `${quote} indeed`, explanation: 'Smoother.', type: 'grammar' },
      { original: 'I never said this sentence at all', corrected: 'x', explanation: 'invented', type: 'grammar' },
      { original: quote, corrected: quote, explanation: 'no change', type: 'grammar' },
    ],
    ...extra,
  })
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  if (url.includes('/audio/transcriptions')) {
    if (sttMode === 'rate') return json(429, { error: { message: 'Rate limit reached. Please try again in 7.5s' } })
    if (sttMode === 'corrupt') return json(400, { error: { message: 'could not process file' } })
    if (sttDelayMs) await sleep(sttDelayMs)
    const file = init.body.get('file')
    const key = (await file.text()).split(':')[1]
    const s = scripts.get(key)
    return s ? json(200, s) : json(200, { text: '', words: [], segments: [{ no_speech_prob: 0.95, avg_logprob: -1.5 }], duration: 2 })
  }
  const provider = url.includes('groq.com') ? 'groq' : url.includes('googleapis.com') ? 'gemini' : null
  if (!provider) return json(404, {})
  const body = JSON.parse(init.body)
  calls[provider].push({ ...body, _auth: init.headers?.Authorization })
  const next = queues[provider].shift()
  if (next) return next(body)
  const isExaminer = body.messages.some(m => /TRANSCRIPT/.test(m.content))
  if (isExaminer) return completion(verdictFor(body.messages[1].content))
  return completion('I see. And what will you do to help him?')
}

// ── Mongo ────────────────────────────────────────────────────────────────────
const SMOKE_DB = 'hidaya_english_coach_smoke'
await mongoose.connect(process.env.MONGODB_URI, { dbName: SMOKE_DB })
if (mongoose.connection.name !== SMOKE_DB) {
  console.error(`Refusing to run: connected to "${mongoose.connection.name}", expected "${SMOKE_DB}"`)
  process.exit(1)
}
await mongoose.connection.dropDatabase()
await Promise.all([CoachSession.syncIndexes(), User.syncIndexes()])

const call = async (handler, req) => {
  let status = 200, out
  const res = { status(c) { status = c; return this }, json(b) { out = b; return this } }
  await handler({ method: 'POST', path: '/', headers: {}, query: {}, params: {}, body: {}, ...req }, res)
  return { status, body: out }
}

const GOOD = 'Wa alaikum assalam Mrs Ahmed thank you for calling I completely understand your concern about Yusuf and I am sorry the class started late last week'
const GOOD2 = 'He has finished two new pages this month and his letters are much clearer now but um he needs to practise for ten minutes every day between our classes'

try {
  // ── Measurements ──────────────────────────────────────────────────────────
  console.log('\nSpeaking measurements')
  let m = turnMetrics(stt('So um I think uh he is doing well', { pausesAfter: [2] }), 1500)
  ok(m.metrics.fillerCount === 2 && m.metrics.wordCount === 7, 'fillers counted apart from words (2 fillers, 7 words)')
  ok(m.metrics.longPauses === 1 && m.metrics.longestPauseSec >= 1.5, 'a 1.6 s gap is one long pause')
  ok(m.metrics.responseDelayMs === 1500 && m.metrics.leadingSilenceSec === 0.5, 'response delay and leading silence kept')
  ok(!m.noSpeech && !m.metrics.lowConfidence, 'clear speech is speech')
  ok(turnMetrics(stt('Thank you.', { noSpeechProb: 0.7 })).noSpeech, 'Whisper\'s "Thank you." in silence → no speech')
  ok(turnMetrics(stt('Thank you.', { noSpeechProb: 0.05 })).noSpeech === false, 'a real "Thank you." is kept')
  ok(turnMetrics({ text: '', words: [], segments: [] }).noSpeech, 'empty transcript → no speech')
  ok(turnMetrics(stt('mumble mumble words here', { logprob: -1.2 })).metrics.lowConfidence, 'low Whisper confidence flagged')
  ok(turnMetrics({ text: 'hello there my friend', segments: [] }).metrics.wordCount === 4, 'no word timings → words counted from the text')
  ok(turnMetrics(stt('x'), 999_999).metrics.responseDelayMs === 60_000, 'response delay clamped to 60 s')

  ok(Math.abs(mattr(['a', 'b', 'c', 'd']) - 1) < 1e-9 && mattr(['a', 'a', 'a', 'a']) === 0.25, 'MATTR on short lists = type/token ratio')
  const long = Array.from({ length: 200 }, (_, i) => `w${i % 30}`)
  ok(mattr(long) > 0.7 && mattr(long) < 0.8, 'MATTR on a long list uses the moving window')

  const turns = [
    { role: 'persona', text: 'Hello' },
    { role: 'tester', text: GOOD, metrics: turnMetrics(stt(GOOD), 800).metrics },
    { role: 'persona', text: 'And?' },
    { role: 'tester', text: GOOD2, metrics: turnMetrics(stt(GOOD2, { pausesAfter: [5] }), 1200).metrics },
  ]
  const sm = sessionMetrics(turns)
  ok(sm.wordCount === 54 && sm.fillerCount === 1 && sm.wpm > 100 && sm.wpm < 160, `whole-call figures (${sm.wordCount} words, ${sm.wpm} wpm)`)
  ok(sm.avgResponseSec > 0.9 && sm.avgResponseSec < 1.3, 'average response = browser delay + leading silence')
  ok(fluencyScore(sm) >= 80, `fluent speech scores high on fluency (${fluencyScore(sm)})`)
  ok(fluencyScore({ ...sm, speakingSec: 10 }) === null, 'under 20 s of speech → fluency not marked')
  ok(fluencyScore({ ...sm, wpm: 60, fillersPerMin: 12, longPausesPerMin: 7, avgResponseSec: 9 }) < 40, 'slow, hesitant speech scores low')
  ok(diversityScore({ lexicalDiversity: 0.8, wordCount: 100 }) === 100 && diversityScore({ lexicalDiversity: 0.8, wordCount: 10 }) === null, 'vocabulary variety needs 30+ words')
  ok(overallScore({ fluency: null, grammar: 80, vocabulary: 80, professionalism: 80, clarity: 80, handling: 80 }) === 80, 'a missing area is left out of the overall')
  ok(overallScore({ fluency: 100, grammar: 0, vocabulary: 0, professionalism: 0, clarity: 0, handling: 0 }) === 20, 'fluency weighs 20%')
  ok(bandFor(80) === 'excellent' && bandFor(65) === 'good' && bandFor(50) === 'developing' && bandFor(49) === 'needs_work', 'bands at 80 / 65 / 50')

  // ── The character ─────────────────────────────────────────────────────────
  console.log('\nThe character')
  ok(cleanReply('Sarah Ahmed: *sighs* Well, **fine** 😊. (pauses) What next?', 'Sarah Ahmed') === 'Well, fine. What next?', 'stage directions, label, markdown and emoji stripped')
  ok(cleanReply('I paid (in full) already.', 'Sarah') === 'I paid (in full) already.', 'ordinary brackets kept')
  ok(cleanReply('a. '.repeat(400)).length <= 421, 'long replies cut at a sentence')
  const hist = historyMessages(Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'tester' : 'persona', text: `t${i}` })))
  ok(hist[0].role === 'user' && hist.length <= 21 && hist[3].role === 'user', 'long history trimmed, still user-first after the cut')

  process.env.GROQ_API_KEY = 'gsk_test'
  process.env.GEMINI_API_KEY = 'gem_test'
  const draft = { scenarioKey: 'worried_parent', scenario: { personaName: 'Sarah Ahmed' }, difficulty: 'normal', turns: [{ role: 'persona', text: 'Hi' }, { role: 'tester', text: 'Hello' }] }
  queues.groq.push(() => completion('As an AI language model I cannot do that.'))
  let pr = await personaReply(draft, 300)
  ok(pr.provider === 'gemini' && !/AI/.test(pr.text), 'a model that breaks character is replaced by the other provider')
  queues.groq.push(() => completion('As an AI, sorry.'))
  queues.gemini.push(() => completion('I am an AI assistant.'))
  pr = await personaReply(draft, 300)
  ok(pr.provider === 'fallback' && FALLBACK_LINES.includes(pr.text), 'both break character → in-character fallback line')

  // ── The examiner ──────────────────────────────────────────────────────────
  console.log('\nThe examiner')
  ok(parseJsonReply('```json\n{"a":1}\n```').a === 1 && parseJsonReply('Here: {"a":2} ok').a === 2 && parseJsonReply('nope') === null, 'JSON pulled out of fences and prose')
  const said = ['I am agree with you about this', 'he is coming since two days']
  let v = validateVerdict({
    scores: { grammar: 7, vocabulary: 6, professionalism: 8, clarity: 7, handling: 6 },
    improvements: ['a'],
    corrections: [
      { original: 'I am agree with you', corrected: 'I agree with you', type: 'grammar' },
      { original: 'He is coming since two days.', corrected: 'He has been coming for two days.', type: 'weird' },
      { original: 'totally invented sentence', corrected: 'x' },
      { original: 'I am agree with you', corrected: 'I agree with you' },
    ],
  }, said)
  ok(v.scores.grammar === 70 && v.scores.handling === 60, 'answers on a 0–10 scale rescaled to 0–100')
  ok(v.corrections.length === 2, 'invented quote and duplicate dropped (punctuation/case ignored when matching)')
  const v2 = validateVerdict({
    scores: { grammar: 70, vocabulary: 70, professionalism: 70, clarity: 70, handling: 70 }, improvements: ['a'],
    corrections: [
      { original: 'he is coming since two days', corrected: 'He is coming, since two days.' },
      { original: 'I am agree with you about this', corrected: 'I agree with you about this' },
      { original: 'I am agree with you', corrected: 'I agree with you' },
    ],
  }, said)
  ok(v2.corrections.length === 1 && v2.corrections[0].original.startsWith('I am agree with you about'), 'punctuation-only and overlapping corrections dropped')
  ok(v.corrections[1].type === 'grammar', 'unknown correction type → grammar')
  ok(validateVerdict({ scores: { grammar: 70 }, improvements: ['a'] }, said) === null, 'a missing area rejects the answer')
  ok(validateVerdict({ scores: { grammar: 150, vocabulary: '80', professionalism: -5, clarity: 70, handling: 70 }, improvements: ['a'] }, said).scores.grammar === 100, 'scores clamped, numeric strings read')

  // ── Providers ─────────────────────────────────────────────────────────────
  console.log('\nProviders')
  resetCoachAiHealth()
  const TPD = () => json(429, { error: { message: 'Rate limit reached on tokens per day (TPD)' } })
  const busy = () => json(503, { error: { message: 'This model is currently experiencing high demand.' } })
  queues.groq.push(TPD)
  let c = await chat({ purpose: 'actor', messages: [{ role: 'user', content: 'hi' }] })
  ok(c.provider === 'groq' && c.model === 'openai/gpt-oss-20b', 'first Groq model out of quota → the next Groq model (quotas are per model)')
  const lastGroq = calls.groq[calls.groq.length - 1]
  ok(lastGroq.reasoning_effort === 'low' && lastGroq.max_tokens >= 1300, 'GPT-OSS gets short reasoning and room for it')
  queues.groq.push(TPD)
  c = await chat({ purpose: 'actor', messages: [{ role: 'user', content: 'hi' }] })
  ok(c.provider === 'gemini', 'every Groq model out of quota → the character comes from Gemini')
  ok(coachAiStatus().providers.groq.coolingDownSec > 1700, 'a daily cap rests those models for 30 minutes')
  const before = calls.groq.length
  c = await chat({ purpose: 'actor', messages: [{ role: 'user', content: 'hi' }] })
  ok(c.provider === 'gemini' && calls.groq.length === before, 'Groq is skipped while it rests')
  ok(calls.gemini[calls.gemini.length - 1].reasoning_effort === 'minimal', 'Gemini 3 character: minimal thinking')
  resetCoachAiHealth()
  queues.gemini.push(busy, busy)
  c = await chat({ purpose: 'examiner', messages: [{ role: 'user', content: 'x' }] })
  ok(c.provider === 'groq', 'every Gemini model overloaded → the examiner falls back to Groq')
  resetCoachAiHealth()
  queues.gemini.push(() => json(404, { error: { message: 'This model models/gemini-3.6-flash is no longer available to new users.' } }))
  c = await chat({ purpose: 'examiner', messages: [{ role: 'user', content: 'x' }] })
  ok(c.provider === 'gemini' && c.model === 'gemini-3.8-flash', 'a retired model is skipped for the next one')
  const n = calls.gemini.length
  c = await chat({ purpose: 'examiner', messages: [{ role: 'user', content: 'x' }] })
  ok(c.model === 'gemini-3.8-flash' && calls.gemini.length === n + 1, '…and not asked again')
  ok(coachAiStatus().models.geminiExaminer === 'gemini-3.8-flash' && coachAiStatus().models.unavailable.includes('gemini/gemini-3.6-flash'), 'settings show the model in use and the retired one')
  resetCoachAiHealth()
  process.env.GROQ_API_KEYS = 'gsk_second, gsk_test'
  ok(coachAiStatus().providers.groq.keys === 2, 'several keys, duplicates ignored')
  queues.groq.push(TPD)
  c = await chat({ purpose: 'actor', messages: [{ role: 'user', content: 'hi' }] })
  ok(c.model === 'openai/gpt-oss-120b' && calls.groq[calls.groq.length - 2]._auth === 'Bearer gsk_second' && calls.groq[calls.groq.length - 1]._auth === 'Bearer gsk_test', 'first key out of quota → the same model with the next key')
  queues.groq.push(() => json(401, { error: { message: 'Invalid API Key' } }))
  resetCoachAiHealth()
  c = await chat({ purpose: 'actor', messages: [{ role: 'user', content: 'hi' }] })
  ok(c.provider === 'groq' && calls.groq[calls.groq.length - 1]._auth === 'Bearer gsk_test' && coachAiStatus().providers.groq.keysRejected === 1, 'a rejected key is set aside, the next key carries on')
  delete process.env.GROQ_API_KEYS
  resetCoachAiHealth()
  queues.gemini.push(() => json(400, { error: { message: 'schema not supported' } }), () => completion('{"ok":1}'))
  c = await chat({ purpose: 'examiner', messages: [{ role: 'user', content: 'x' }], jsonSchema: { type: 'object' } })
  const lastGemini = calls.gemini[calls.gemini.length - 1]
  ok(c.provider === 'gemini' && !lastGemini.response_format, 'Gemini refusing the schema → same call without it')
  resetCoachAiHealth()
  delete process.env.GEMINI_API_KEY
  ok(coachAiStatus().ready && !coachAiStatus().examinerIndependent, 'Groq alone: ready, examiner not independent')
  delete process.env.GROQ_API_KEY
  ok(!coachAiStatus().ready, 'no keys: not ready')

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const roles = {}
  for (const key of ['super_admin', 'admin', 'qci', 'tutor', 'student']) {
    roles[key] = await Role.create({ key, name: key, permissions: DEFAULT_ROLE_PERMISSIONS[key], system: true })
  }
  const mk = (email, role) => User.create({ email, password: 'secret123', displayName: email.split('@')[0], roles: [roles[role]._id] })
  const tutorU = await mk('bilal@x.test', 'tutor')
  const tutor2U = await mk('usman@x.test', 'tutor')
  const qciU = await mk('qci@x.test', 'qci')
  const adminU = await mk('admin@x.test', 'super_admin')
  const loadReq = async (id) => {
    const user = await User.findById(id).populate('roles').lean()
    return { user, userId: user._id, userPermissions: effectivePermissions(user) }
  }
  const tutor = await loadReq(tutorU._id)
  const tutor2 = await loadReq(tutor2U._id)
  const qci = await loadReq(qciU._id)
  const admin = await loadReq(adminU._id)
  const turnReq = (req, id, buf, query = {}) => ({ ...req, params: { id: String(id) }, body: buf, headers: { 'content-type': 'audio/webm;codecs=opus' }, query })

  console.log('\nPermissions')
  ok(tutor.userPermissions.has('coach.practice') && !tutor.userPermissions.has('coach.review'), 'tutor: practice only')
  ok(qci.userPermissions.has('coach.review') && !qci.userPermissions.has('coach.manage'), 'QCI: practice + review')
  ok(['coach.practice', 'coach.review', 'coach.manage'].every(p => DEFAULT_ROLE_PERMISSIONS.admin.includes(p)), 'admin: all three')
  ok(!DEFAULT_ROLE_PERMISSIONS.student.some(p => p.startsWith('coach.')), 'student: none')

  // ── Starting a call ───────────────────────────────────────────────────────
  console.log('\nStarting a call')
  let r = await call(getConfig, { ...tutor })
  ok(r.body.ready === false && r.body.scenarios.length === 5, 'not set up: config says so, lists 5 scenarios')
  const startBody = { scenarioKey: 'worried_parent', difficulty: 'normal', durationMin: 5, consent: true }
  r = await call(startSession, { ...tutor, body: startBody })
  ok(r.status === 503 && r.body.code === 'not_configured', 'no keys → 503 not_configured')
  process.env.GROQ_API_KEY = 'gsk_test'
  process.env.GEMINI_API_KEY = 'gem_test'
  resetCoachAiHealth()
  await CoachSettings.updateOne({ key: 'default' }, { dailyLimitPerUser: 0 }) // limits are tested on their own below

  r = await call(startSession, { ...tutor, body: { ...startBody, consent: false } })
  ok(r.status === 400 && r.body.code === 'consent_required', 'consent required')
  r = await call(startSession, { ...tutor, body: { ...startBody, scenarioKey: 'nope' } })
  ok(r.status === 400, 'unknown scenario refused')
  r = await call(startSession, { ...tutor, body: { ...startBody, difficulty: 'insane' } })
  ok(r.status === 400, 'unknown difficulty refused')
  r = await call(startSession, { ...tutor, body: { ...startBody, durationMin: 7 } })
  ok(r.status === 400, 'a length not offered is refused')

  r = await call(startSession, { ...tutor, body: startBody })
  ok(r.status === 201 && r.body.session.turns.length === 1 && r.body.session.turns[0].role === 'persona', 'call opens with the character\'s scripted first line')
  ok(r.body.session.scenario.goals === undefined, 'the marking goals are hidden during the call')
  const s1 = r.body.session.id
  r = await call(startSession, { ...tutor, body: startBody })
  ok(r.status === 409 && r.body.code === 'active_exists' && String(r.body.sessionId) === String(s1), 'a second call → 409 with the live one\'s id')
  const twin = await Promise.all([call(startSession, { ...tutor2, body: startBody }), call(startSession, { ...tutor2, body: startBody })])
  ok(twin.filter(x => x.status === 201).length === 1 && twin.filter(x => x.status === 409).length === 1, 'two Start taps at once → exactly one call')
  r = await call(getConfig, { ...tutor })
  ok(r.body.ready && String(r.body.active.id) === String(s1), 'config reports the live call')

  // ── Turns ─────────────────────────────────────────────────────────────────
  console.log('\nAnswers')
  r = await call(addTurn, turnReq(tutor2, s1, say('a', GOOD)))
  ok(r.status === 404, 'someone else\'s call → 404')
  r = await call(addTurn, turnReq(tutor, s1, Buffer.alloc(100)))
  ok(r.status === 422 && r.body.code === 'no_speech', 'a near-empty upload → no_speech')
  r = await call(addTurn, { ...turnReq(tutor, s1, audio('a')), headers: { 'content-type': 'application/octet-stream' } })
  ok(r.status === 415, 'unknown audio type → 415')
  r = await call(addTurn, turnReq(tutor, s1, audio('silence')))
  ok(r.status === 422 && r.body.code === 'no_speech', 'silence → no_speech')
  scripts.set('thanks', stt('Thank you.', { noSpeechProb: 0.8 }))
  r = await call(addTurn, turnReq(tutor, s1, audio('thanks')))
  ok(r.status === 422, 'Whisper\'s "Thank you." hallucination → no_speech')
  sttMode = 'corrupt'
  r = await call(addTurn, turnReq(tutor, s1, audio('a')))
  ok(r.status === 422 && r.body.code === 'bad_audio', 'a file Whisper can\'t read → bad_audio')
  sttMode = 'ok'
  let doc = await CoachSession.findById(s1)
  ok(doc.turns.length === 1 && doc.busyAt === null, 'none of those were recorded, lock free')

  r = await call(addTurn, turnReq(tutor, s1, say('a', GOOD), { clientTurnId: 'c1', responseDelayMs: '900' }))
  ok(r.status === 200 && r.body.tester.text === GOOD && r.body.reply.text.length > 5, 'an answer is transcribed and the character replies')
  ok(r.body.tester.metrics.wordCount === 26 && r.body.remainingSec > 250, 'the answer carries its measurements and the time left')
  const sysPrompt = calls.groq[calls.groq.length - 1].messages[0].content
  ok(/Sarah Ahmed/.test(sysPrompt) && /plenty of time/.test(sysPrompt), 'the character gets its brief and the clock')
  r = await call(addTurn, turnReq(tutor, s1, audio('a'), { clientTurnId: 'c1' }))
  doc = await CoachSession.findById(s1)
  ok(r.body.replayed && doc.turns.length === 3 && doc.testerTurns === 1, 'the same upload retried → same reply, not added twice')

  sttDelayMs = 600 // the first answer is still being heard when the second arrives
  const both = await Promise.all([
    call(addTurn, turnReq(tutor, s1, say('b', GOOD2), { clientTurnId: 'c2' })),
    call(addTurn, turnReq(tutor, s1, audio('b'), { clientTurnId: 'c3' })),
  ])
  sttDelayMs = 0
  ok(both.filter(x => x.status === 200).length === 1 && both.filter(x => x.body.code === 'busy').length === 1, 'two answers at once → one lands, the other is told to wait')

  const RPD = () => json(429, { error: { message: 'Rate limit reached on requests per day (RPD)' } })
  const GQ = () => json(429, { error: { message: 'Quota exceeded: GenerateRequestsPerDayPerProjectPerModel' } })
  queues.groq.push(RPD, RPD)
  queues.gemini.push(GQ, GQ, GQ) // the character has three Gemini models to fall back on
  r = await call(addTurn, turnReq(tutor, s1, say('c', 'Okay let me explain the plan we will follow from next week onwards'), { clientTurnId: 'c4' }))
  doc = await CoachSession.findById(s1)
  ok(r.status === 503 && r.body.code === 'ai_busy' && r.body.retryAfterSec > 0, 'both providers out of quota → 503 ai_busy with a wait')
  ok(doc.turns.length === 5 && doc.busyAt === null, 'nothing half-saved and the lock released')
  resetCoachAiHealth()

  // ── Finishing ─────────────────────────────────────────────────────────────
  console.log('\nFinishing and marking')
  await CoachSession.updateOne({ _id: s1 }, { busyAt: new Date() })
  r = await call(finishSession, { ...tutor, params: { id: s1 }, body: { reason: 'ended_early' } })
  ok(r.status === 409 && r.body.code === 'busy', 'finishing while an answer is in flight → wait')
  await CoachSession.updateOne({ _id: s1 }, { busyAt: null })

  r = await call(finishSession, { ...tutor, params: { id: s1 }, body: { reason: 'ended_early' } })
  ok(r.body.session.status === 'scoring', 'enough speech → scoring')
  ok(await waitFor(async () => (await CoachSession.findById(s1)).status === 'scored'), 'the examiner marks it in the background')
  doc = await CoachSession.findById(s1)
  ok(doc.result.overall > 0 && doc.result.band && doc.result.scores.fluency >= 0, `scored ${doc.result.overall} (${doc.result.band})`)
  ok(doc.result.corrections.length === 1, 'invented and no-op corrections dropped, the real one kept')
  ok(doc.result.examiner.startsWith('gemini/') && doc.result.shortSample === true, 'marked by Gemini; a short sample is flagged')
  ok(doc.result.scores.vocabulary !== 70, 'vocabulary blends the examiner with measured variety')
  ok(doc.usage.audioSec > 0 && doc.usage.promptTokens > 0, 'usage recorded')
  r = await call(finishSession, { ...tutor, params: { id: s1 }, body: {} })
  ok(r.status === 200 && r.body.session.status === 'scored', 'finishing again is harmless')
  r = await call(getSession, { ...tutor, params: { id: s1 } })
  ok(r.body.session.result && r.body.session.scenario.goals.length > 0 && r.body.canReview === false, 'the tester sees the scorecard and the goals')
  r = await call(addTurn, turnReq(tutor, s1, say('d', GOOD)))
  ok(r.status === 409 && r.body.code === 'not_active', 'no answers after the call ended')

  // Tutor 2: too short
  const s2 = (await CoachSession.findOne({ userId: tutor2U._id, status: 'active' }))._id
  await call(addTurn, turnReq(tutor2, s2, say('e', 'Hello yes')))
  r = await call(finishSession, { ...tutor2, params: { id: String(s2) }, body: { reason: 'ended_early' } })
  ok(r.body.session.status === 'too_short', 'a few words → too_short, not marked')

  // A bad examiner answer, then the other provider
  r = await call(startSession, { ...tutor2, body: { ...startBody, scenarioKey: 'small_talk' } })
  const s3 = r.body.session.id
  await call(addTurn, turnReq(tutor2, s3, say('f', GOOD)))
  await call(addTurn, turnReq(tutor2, s3, say('g', GOOD2)))
  queues.gemini.push(() => completion('I think the tester did fine overall.'))
  r = await call(finishSession, { ...tutor2, params: { id: s3 }, body: { reason: 'time_up' } })
  ok(await waitFor(async () => (await CoachSession.findById(s3)).status === 'scored'), 'unusable Gemini scorecard → marked by Groq instead')
  ok((await CoachSession.findById(s3)).result.examiner.startsWith('groq/'), 'examiner recorded as Groq')

  // Quota exhausted while marking: waits, doesn't fail
  r = await call(startSession, { ...tutor2, body: { ...startBody, scenarioKey: 'new_parent' } })
  const s4 = r.body.session.id
  await call(addTurn, turnReq(tutor2, s4, say('h', GOOD)))
  await call(addTurn, turnReq(tutor2, s4, say('i', GOOD2)))
  const q = () => json(429, { error: { message: 'quota per day' } })
  queues.gemini.push(q, q)
  queues.groq.push(q, q)
  await call(finishSession, { ...tutor2, params: { id: s4 }, body: { reason: 'time_up' } })
  await waitFor(async () => { const d = await CoachSession.findById(s4); return d.scoringError && !d.scoringLockAt })
  doc = await CoachSession.findById(s4)
  ok(doc.status === 'scoring' && doc.scoringAttempts === 0 && doc.scoringLockAt === null, 'out of quota while marking → still waiting, not failed')
  resetCoachAiHealth()
  await scoreSession(s4)
  ok((await CoachSession.findById(s4)).status === 'scored', 'marked once the quota is back')

  // Three unusable answers → failed → rescore
  r = await call(startSession, { ...tutor2, body: { ...startBody, scenarioKey: 'progress_update' } })
  const s5 = r.body.session.id
  await call(addTurn, turnReq(tutor2, s5, say('j', GOOD)))
  await call(addTurn, turnReq(tutor2, s5, say('k', GOOD2)))
  await CoachSession.updateOne({ _id: s5 }, { scoringAttempts: 2 })
  queues.gemini.push(() => completion('garbage'))
  queues.groq.push(() => completion('{"scores":{}}'))
  await call(finishSession, { ...tutor2, params: { id: s5 }, body: {} })
  ok(await waitFor(async () => (await CoachSession.findById(s5)).status === 'failed'), 'three unusable scorecards → failed')
  r = await call(getSession, { ...tutor2, params: { id: s5 } })
  ok(r.body.session.status === 'failed' && r.body.session.scoringError, 'the tester sees why')
  r = await call(rescoreSession, { ...tutor, params: { id: s5 } })
  ok(r.status === 404, 'someone else can\'t rescore it')
  r = await call(rescoreSession, { ...tutor2, params: { id: s5 } })
  ok(await waitFor(async () => (await CoachSession.findById(s5)).status === 'scored'), 'the tester retries and it is marked')
  r = await call(rescoreSession, { ...tutor2, params: { id: s5 } })
  ok(r.status === 409, 'a marked test can\'t be re-marked')

  // ── Time ──────────────────────────────────────────────────────────────────
  console.log('\nThe clock')
  r = await call(startSession, { ...tutor, body: startBody })
  const s6 = r.body.session.id
  await CoachSession.updateOne({ _id: s6 }, { endsAt: new Date(Date.now() - 30_000) })
  r = await call(addTurn, turnReq(tutor, s6, say('l', GOOD)))
  ok(r.status === 200 && /nearly over|over\./.test(calls.groq[calls.groq.length - 1].messages[0].content), 'an answer 30 s after the buzzer is still taken; the character is told to wrap up')
  await CoachSession.updateOne({ _id: s6 }, { endsAt: new Date(Date.now() - 120_000) })
  r = await call(addTurn, turnReq(tutor, s6, say('m', GOOD2)))
  ok(r.status === 409 && r.body.code === 'time_up' && r.body.session.status === 'too_short', 'past the grace → time_up and the call is closed')

  await CoachSession.updateOne({ _id: s6 }, { status: 'active', endsAt: new Date(Date.now() - 10 * 60_000) })
  await CoachSession.updateOne({ _id: s6 }, { $set: { testerWords: 200 } })
  await sweepCoachSessions()
  doc = await CoachSession.findById(s6)
  ok(['scoring', 'scored'].includes(doc.status) && doc.endReason === 'expired', 'the sweeper closes a call whose tab was closed')
  ok(await waitFor(async () => (await CoachSession.findById(s6)).status === 'scored'), '…and marks it')

  // Cap on answers
  r = await call(startSession, { ...tutor, body: startBody })
  const s7 = r.body.session.id
  await CoachSession.updateOne({ _id: s7 }, { testerTurns: MAX_TESTER_TURNS })
  r = await call(addTurn, turnReq(tutor, s7, say('n', GOOD)))
  ok(r.status === 409 && r.body.code === 'turn_limit', `the ${MAX_TESTER_TURNS}-answer cap`)
  await CoachSession.updateOne({ _id: s7 }, { testerTurns: 0 })
  r = await call(finishSession, { ...tutor, params: { id: s7 }, body: { reason: 'ended_early' } })
  ok(r.body.session.status === 'abandoned', 'ended with no answers → abandoned')

  // ── Limits ────────────────────────────────────────────────────────────────
  console.log('\nLimits')
  await CoachSettings.updateOne({ key: 'default' }, { dailyLimitPerUser: 3 })
  r = await call(getConfig, { ...tutor })
  ok(r.body.usage.used === 2 && r.body.usage.remaining === 1, 'the abandoned call doesn\'t count (2 of 3 used)')
  r = await call(startSession, { ...tutor, body: startBody })
  await call(finishSession, { ...tutor, params: { id: r.body.session.id }, body: {} })
  await call(addTurn, turnReq(tutor, r.body.session.id, say('o', GOOD)))
  await CoachSession.updateOne({ _id: r.body.session.id }, { status: 'too_short' })
  r = await call(startSession, { ...tutor, body: startBody })
  ok(r.status === 429 && r.body.code === 'daily_limit' && new Date(r.body.nextAvailableAt) > new Date(), 'over the per-person cap → 429 with when the next test is free')
  await CoachSettings.updateOne({ key: 'default' }, { dailyLimitPerUser: 0, orgDailyLimit: 3 })
  r = await call(startSession, { ...tutor, body: startBody })
  ok(r.status === 429 && r.body.code === 'org_limit', 'the academy-wide cap')
  await CoachSettings.updateOne({ key: 'default' }, { orgDailyLimit: 0, disabledScenarios: ['worried_parent'] })
  r = await call(startSession, { ...tutor, body: startBody })
  ok(r.status === 400, 'a scenario switched off can\'t be started')
  r = await call(getConfig, { ...tutor })
  ok(r.body.scenarios.length === 4 && !r.body.scenarios.some(s => s.key === 'worried_parent'), '…and is not offered')
  ok(r.body.scenarios.every(s => !('persona' in s) && !('goals' in s)), 'the character\'s hidden brief never reaches the browser')
  await CoachSettings.updateOne({ key: 'default' }, { enabled: false, disabledScenarios: [] })
  r = await call(startSession, { ...tutor, body: startBody })
  ok(r.status === 403 && r.body.code === 'disabled', 'switched off → 403')
  await CoachSettings.updateOne({ key: 'default' }, { enabled: true })

  // ── Settings ──────────────────────────────────────────────────────────────
  console.log('\nSettings')
  r = await call(updateSettings, { ...admin, body: { durations: [7] } })
  ok(r.status === 400, 'no valid call length → refused')
  r = await call(updateSettings, { ...admin, body: { disabledScenarios: ['worried_parent', 'new_parent', 'unmotivated_student', 'progress_update', 'small_talk'] } })
  ok(r.status === 400, 'every scenario off → refused')
  r = await call(updateSettings, { ...admin, body: { dailyLimitPerUser: 2.5 } })
  ok(r.status === 400, 'a fractional limit → refused')
  r = await call(updateSettings, { ...admin, body: { durations: [10, 5, 5, 15], dailyLimitPerUser: 4, minTesterWords: 30 } })
  ok(r.status === 200 && r.body.settings.durations.join() === '5,10,15' && r.body.settings.dailyLimitPerUser === 4, 'saved, lengths de-duplicated and sorted')
  r = await call(getSettings, { ...admin })
  ok(r.body.ai.providers.groq.configured && r.body.last24h.started > 0 && r.body.scenarios.length === 5, 'settings show provider status and the last 24 hours')

  // ── Reviewers ─────────────────────────────────────────────────────────────
  console.log('\nReviewers')
  r = await call(getSession, { ...tutor2, params: { id: s1 } })
  ok(r.status === 404, 'a tester can\'t open someone else\'s test')
  r = await call(getSession, { ...qci, params: { id: s1 } })
  ok(r.status === 200 && r.body.canReview && r.body.session.user.name === 'bilal', 'a reviewer can, and may review it')
  r = await call(listSessions, { ...qci, query: { userId: String(tutorU._id), status: 'scored' } })
  ok(r.body.items.length === 2 && r.body.items.every(i => i.user.name === 'bilal'), 'list filtered by person and status')
  r = await call(listSessions, { ...qci, query: { sort: 'score:desc' } })
  ok(r.body.items.length >= 6 && !r.body.items.some(i => i.status === 'abandoned'), 'abandoned calls are left out of the list')
  r = await call(listPeople, { ...qci })
  ok(r.body.items.length === 2, 'people who have taken a test')
  r = await call(listMine, { ...tutor })
  ok(r.body.items.every(i => i.user === null || String(i.user?.id) === String(tutorU._id)) && !r.body.items.some(i => i.status === 'abandoned'), 'my tests only, no abandoned')

  r = await call(reviewSession, { ...admin, params: { id: s1 }, body: { score: 101 } })
  ok(r.status === 400, 'a mark over 100 refused')
  r = await call(reviewSession, { ...admin, params: { id: s1 }, body: {} })
  ok(r.status === 400, 'an empty review refused')
  const own = await call(startSession, { ...admin, body: { ...startBody, scenarioKey: 'small_talk' } })
  await call(addTurn, turnReq(admin, own.body.session.id, say('p', GOOD)))
  await call(addTurn, turnReq(admin, own.body.session.id, say('q', GOOD2)))
  await call(finishSession, { ...admin, params: { id: own.body.session.id }, body: {} })
  await waitFor(async () => (await CoachSession.findById(own.body.session.id)).status === 'scored')
  r = await call(reviewSession, { ...admin, params: { id: own.body.session.id }, body: { score: 90 } })
  ok(r.status === 403, 'nobody reviews their own test')
  const ai = (await CoachSession.findById(s1)).result.overall
  r = await call(reviewSession, { ...qci, params: { id: s1 }, body: { score: ai - 10, note: 'Good empathy; work on tenses.' } })
  ok(r.status === 200 && r.body.session.review.score === ai - 10 && r.body.session.review.byName === 'qci', 'a reviewer adds a mark and a note')
  ok(await waitFor(async () => (await Notification.countDocuments({ userId: tutorU._id, type: 'coach_feedback' })) === 1), 'the tester is notified')
  r = await call(getOverview, { ...qci, query: { days: 30 } })
  ok(r.body.totals.tests === 6 && r.body.totals.testers === 3 && r.body.people.length === 3 && r.body.weekly.length >= 1, 'overview: totals, people, weeks')
  ok(r.body.calibration.reviewed === 1 && r.body.calibration.meanDiff === 10, 'calibration: AI vs reviewer difference')
  const bilal = r.body.people.find(p => p.user.name === 'bilal')
  ok(bilal.tests === 2 && bilal.change !== null && bilal.areas.grammar > 0, 'per-person: tests, change, area averages')

  r = await call(deleteSession, { ...admin, params: { id: s3 } })
  ok(r.status === 200 && !(await CoachSession.findById(s3)), 'a manager deletes a test')
} catch (err) {
  fail++
  console.error(err)
} finally {
  await mongoose.connection.dropDatabase()
  await mongoose.disconnect()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

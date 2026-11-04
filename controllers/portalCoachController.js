/*
 * English Coach (/portal/english-coach) — timed, spoken role-play calls with an
 * AI character, then a scorecard.
 *
 * Permissions:
 *   coach.practice — take tests and see your own results
 *   coach.review   — see everyone's results, the team overview, and add your
 *                    own mark + feedback to a test (the human check on the AI)
 *   coach.manage   — settings, and deleting tests
 * Student accounts never reach this (denyStudentAccounts on the router).
 *
 * A call, end to end:
 *   POST /sessions               opens the call; the character's first line is
 *                                scripted (instant, no AI quota spent)
 *   POST /sessions/:id/turns     one recorded answer (raw audio body) →
 *                                Whisper → speaking measurements → the
 *                                character's reply. The audio is not stored.
 *   POST /sessions/:id/finish    ends it; enough speech → 'scoring', and the
 *                                examiner runs in the background
 *   GET  /sessions/:id           the browser polls this until 'scored'
 *
 * What can go wrong, and what happens:
 *   two tabs / double-tap Start   one active call per user (unique index) → 409 active_exists
 *   the same answer uploaded twice clientTurnId → the stored reply is returned again
 *   two answers at once           per-call turn lock (busyAt) → 409 busy
 *   silence, noise, Whisper's     no_speech → 422, nothing recorded, the tester re-records
 *     "Thank you." hallucination
 *   an answer after time is up    accepted for TURN_GRACE_SEC (it was spoken in time),
 *                                 then the call is closed → 409 time_up
 *   tab closed mid-call           the sweeper closes it after the clock runs out and
 *                                 marks it if there was enough speech
 *   AI out of free quota          503 ai_busy + retryAfterSec on a turn (the tester's
 *                                 audio is kept in the browser to retry); scoring
 *                                 waits and retries instead of failing
 *   server restart while marking  a stale scoring claim is retaken by the sweeper
 *   examiner invents a quote      dropped (services/coachExaminer.js)
 *   clock skew                    every response carries serverNow
 */
import CoachSession from '../models/CoachSession.js'
import CoachSettings from '../models/CoachSettings.js'
import User from '../models/User.js'
import { COACH_SCENARIOS, DIFFICULTIES, SCENARIO_KEYS, SCENARIO_GROUPS, getScenario, publicScenario, canUseScenario, audienceOf, groupOf } from '../config/coachScenarios.js'
import { transcribe, coachAiStatus, CoachAiError, audioExtension } from '../services/coachAi.js'
import { personaReply } from '../services/coachPersona.js'
import { examineSession } from '../services/coachExaminer.js'
import { turnMetrics, sessionMetrics } from '../utils/coachMetrics.js'
import { createNotification } from './portalNotificationController.js'
import { logActivity } from '../utils/activityLogger.js'

const DAY_MS = 24 * 60 * 60 * 1000
export const TURN_GRACE_SEC = 60          // an answer recorded before the buzzer may still arrive
const SWEEP_AFTER_SEC = 120               // an abandoned call is closed this long after its end
const TURN_LOCK_STALE_MS = 90_000
const SCORING_STALE_MS = 3 * 60_000
const SCORING_MAX_ATTEMPTS = 3            // unusable examiner answers before giving up
const SCORING_GIVE_UP_MS = 6 * 60 * 60_000 // providers down this long → failed (retry by hand)
export const MAX_TESTER_TURNS = 60
const MIN_AUDIO_BYTES = 800
export const MAX_TURN_AUDIO_SEC = 150
export const ALLOWED_DURATIONS = [3, 5, 10, 15]

const has = (req, p) => req.userPermissions?.has(p)
const isOwner = (req, s) => String(s.userId?._id || s.userId) === String(req.userId)

// ── Views ────────────────────────────────────────────────────────────────────
function turnView(t) {
  const v = { role: t.role, text: t.text, at: t.at }
  if (t.role === 'tester' && t.metrics) {
    v.metrics = {
      wordCount: t.metrics.wordCount, fillerCount: t.metrics.fillerCount, fillers: t.metrics.fillers,
      longPauses: t.metrics.longPauses, speakingSec: t.metrics.speakingSec, lowConfidence: !!t.metrics.lowConfidence,
    }
  }
  return v
}

function userView(u) {
  if (!u || !u._id) return null
  return { id: u._id, name: u.displayName || u.email || 'Unknown', email: u.email }
}

export function sessionView(s, { withTurns = true } = {}) {
  const ended = s.status !== 'active'
  const sc = s.scenario || {}
  return {
    id: s._id,
    status: s.status,
    scenarioKey: s.scenarioKey,
    scenario: {
      title: sc.title, summary: sc.summary, brief: sc.brief,
      personaName: sc.personaName, personaRole: sc.personaRole, initials: sc.initials,
      voice: sc.voice, lang: sc.lang, gender: sc.gender,
      group: sc.group, audience: sc.audience,
      // What good handling looks like, and how Hidaya's training says it —
      // shown with the scorecard, not before the call
      goals: ended ? (sc.goals || []) : undefined,
      academyLines: ended ? (sc.academyLines || []) : undefined,
    },
    difficulty: s.difficulty,
    durationSec: s.durationSec,
    startedAt: s.startedAt,
    endsAt: s.endsAt,
    endedAt: s.endedAt,
    endReason: s.endReason,
    testerTurns: s.testerTurns,
    testerWords: s.testerWords,
    turns: withTurns ? (s.turns || []).map(turnView) : undefined,
    metrics: ended ? s.metrics : undefined,
    result: s.status === 'scored' ? s.result : undefined,
    scoringError: s.status === 'failed' ? s.scoringError : undefined,
    review: s.review?.at ? s.review : undefined,
    user: userView(s.userId),
    serverNow: new Date(),
  }
}

function summaryView(s) {
  return {
    id: s._id,
    status: s.status,
    scenarioKey: s.scenarioKey,
    scenarioTitle: s.scenario?.title,
    personaName: s.scenario?.personaName,
    difficulty: s.difficulty,
    durationSec: s.durationSec,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    testerWords: s.testerWords,
    overall: s.result?.overall ?? null,
    band: s.result?.band ?? null,
    scores: s.result?.scores,
    reviewScore: s.review?.score ?? null,
    reviewed: Boolean(s.review?.at),
    user: userView(s.userId),
  }
}

function aiErrorResponse(res, err) {
  if (err instanceof CoachAiError) {
    if (err.code === 'not_configured') return res.status(503).json({ code: 'not_configured', error: 'The English Coach is not set up yet. Please ask an admin.' })
    if (err.code === 'rate_limited') return res.status(503).json({ code: 'ai_busy', retryAfterSec: err.retryAfterSec || 60, error: 'The free AI allowance is busy right now. Please try again shortly.' })
    if (err.code === 'bad_audio') return res.status(422).json({ code: 'bad_audio', error: 'That recording could not be read. Please record your answer again.' })
    return res.status(503).json({ code: 'ai_unavailable', retryAfterSec: err.retryAfterSec || 10, error: 'The AI service did not respond. Please try again.' })
  }
  console.error('English Coach error:', err)
  return res.status(500).json({ error: 'Server error' })
}

// ── Limits ───────────────────────────────────────────────────────────────────
// A call with no answers in it spent nothing and doesn't count.
const COUNTED = { status: { $ne: 'abandoned' } }

async function userUsage(userId, settings) {
  const since = new Date(Date.now() - DAY_MS)
  const recent = await CoachSession.find({ userId, createdAt: { $gte: since }, ...COUNTED })
    .select('createdAt').sort({ createdAt: 1 }).lean()
  const limit = settings.dailyLimitPerUser
  const used = recent.length
  const remaining = limit ? Math.max(0, limit - used) : null
  // The test that has to age out of the 24-hour window before another is allowed
  const nextAvailableAt = limit && used >= limit ? new Date(recent[used - limit].createdAt.getTime() + DAY_MS) : null
  return { limit, used, remaining, nextAvailableAt }
}

async function orgLimitReached(settings) {
  if (!settings.orgDailyLimit) return false
  const n = await CoachSession.countDocuments({ createdAt: { $gte: new Date(Date.now() - DAY_MS) }, ...COUNTED })
  return n >= settings.orgDailyLimit
}

// Switched on in Settings AND open to this person (manager scenarios need coach.manager)
const enabledScenarios = (settings, req) => COACH_SCENARIOS.filter(s => !(settings.disabledScenarios || []).includes(s.key) && canUseScenario(s, req.userPermissions))

// ── Ending and marking ──────────────────────────────────────────────────────
/**
 * Close an active call. Returns the updated session, or the session as it is
 * when it was already closed. `{ busy: true }` when a turn is still in flight
 * (the caller retries once it lands, so the last answer is not left out).
 */
export async function finalizeSession(id, reason) {
  const s = await CoachSession.findById(id)
  if (!s) return null
  if (s.status !== 'active') return { session: s }
  if (s.busyAt && Date.now() - s.busyAt.getTime() < TURN_LOCK_STALE_MS) return { session: s, busy: true }

  const settings = await CoachSettings.getSettings()
  const metrics = sessionMetrics(s.turns)
  let status = 'scoring'
  if (s.testerTurns === 0) status = 'abandoned'
  else if ((s.testerWords || 0) < settings.minTesterWords) status = 'too_short'

  const updated = await CoachSession.findOneAndUpdate(
    { _id: s._id, status: 'active', $or: [{ busyAt: null }, { busyAt: { $lt: new Date(Date.now() - TURN_LOCK_STALE_MS) } }] },
    {
      $set: {
        status, metrics, endedAt: new Date(), busyAt: null,
        endReason: status === 'abandoned' && reason === 'ended_early' ? 'abandoned' : reason,
      },
    },
    { new: true },
  )
  if (!updated) return { session: await CoachSession.findById(id), busy: true }
  if (status === 'scoring') scoreSession(updated._id).catch(err => console.error('English Coach scoring:', err.message))
  return { session: updated }
}

const retryTimers = new Map()
function scheduleScoring(id, delayMs) {
  const key = String(id)
  if (retryTimers.has(key)) return
  const t = setTimeout(() => {
    retryTimers.delete(key)
    scoreSession(id).catch(err => console.error('English Coach scoring:', err.message))
  }, Math.min(Math.max(delayMs, 10_000), 15 * 60_000))
  t.unref?.()
  retryTimers.set(key, t)
}

/** Run the examiner on a call in 'scoring'. Safe to call any number of times. */
export async function scoreSession(id) {
  const now = new Date()
  const s = await CoachSession.findOneAndUpdate(
    { _id: id, status: 'scoring', $or: [{ scoringLockAt: null }, { scoringLockAt: { $lt: new Date(now - SCORING_STALE_MS) } }] },
    { $set: { scoringLockAt: now } },
    { new: true },
  )
  if (!s) return null

  try {
    const { result, usage } = await examineSession(s)
    const done = await CoachSession.findOneAndUpdate(
      { _id: s._id, status: 'scoring', scoringLockAt: now },
      {
        $set: { status: 'scored', result, scoredAt: new Date(), scoringLockAt: null, scoringError: '' },
        $inc: { scoringAttempts: 1, 'usage.promptTokens': usage.promptTokens, 'usage.completionTokens': usage.completionTokens },
      },
      { new: true },
    )
    // Someone who left the page gets told; someone watching the scorecard doesn't need a ping
    if (done && s.endedAt && Date.now() - s.endedAt.getTime() > 2 * 60_000) {
      createNotification({
        userId: s.userId,
        type: 'coach_scored',
        title: 'Your English practice has been marked',
        body: `${s.scenario?.title}: ${result.overall}/100`,
        payload: { sessionId: String(s._id) },
      })
    }
    return done
  } catch (err) {
    const waiting = err instanceof CoachAiError && ['rate_limited', 'unavailable', 'not_configured'].includes(err.code)
    const attempts = s.scoringAttempts + (waiting ? 0 : 1)
    const tooOld = s.endedAt && Date.now() - s.endedAt.getTime() > SCORING_GIVE_UP_MS
    const give = attempts >= SCORING_MAX_ATTEMPTS || tooOld
    await CoachSession.updateOne(
      { _id: s._id, scoringLockAt: now },
      {
        $set: {
          status: give ? 'failed' : 'scoring',
          scoringLockAt: null,
          scoringAttempts: attempts,
          scoringError: String(err.message || 'Scoring failed').slice(0, 300),
        },
      },
    )
    if (!give) scheduleScoring(s._id, waiting ? (err.retryAfterSec || 60) * 1000 : 15_000)
    return null
  }
}

/**
 * Background job: close calls whose tab was closed, and pick up marking that
 * a restart interrupted. Runs on startup and every 2 minutes.
 */
export async function sweepCoachSessions() {
  try {
    const cutoff = new Date(Date.now() - SWEEP_AFTER_SEC * 1000)
    const overdue = await CoachSession.find({ status: 'active', endsAt: { $lt: cutoff } }).select('_id').limit(50).lean()
    for (const s of overdue) await finalizeSession(s._id, 'expired')

    const stale = new Date(Date.now() - SCORING_STALE_MS)
    const pending = await CoachSession.find({ status: 'scoring', $or: [{ scoringLockAt: null }, { scoringLockAt: { $lt: stale } }] })
      .select('_id').sort({ endedAt: 1 }).limit(5).lean()
    for (const s of pending) await scoreSession(s._id)
  } catch (err) {
    console.error('English Coach sweep failed:', err.message)
  }
}

// ── Tester ───────────────────────────────────────────────────────────────────
export async function getConfig(req, res) {
  try {
    const settings = await CoachSettings.getSettings()
    const ai = coachAiStatus()
    const [usage, orgFull, active] = await Promise.all([
      userUsage(req.userId, settings),
      orgLimitReached(settings),
      CoachSession.findOne({ userId: req.userId, status: 'active' }).select('_id endsAt scenario.title').lean(),
    ])
    res.json({
      enabled: settings.enabled,
      ready: ai.ready,
      durations: settings.durations,
      difficulties: DIFFICULTIES,
      scenarios: enabledScenarios(settings, req).map(publicScenario),
      groups: SCENARIO_GROUPS,
      usage,
      orgLimitReached: orgFull,
      minTesterWords: settings.minTesterWords,
      maxTurnSec: 120,
      active: active ? { id: active._id, endsAt: active.endsAt, title: active.scenario?.title } : null,
      serverNow: new Date(),
    })
  } catch (err) {
    console.error('English Coach config:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function startSession(req, res) {
  try {
    const { scenarioKey, difficulty, durationMin, consent } = req.body || {}
    const settings = await CoachSettings.getSettings()
    if (!settings.enabled) return res.status(403).json({ code: 'disabled', error: 'The English Coach is switched off.' })
    if (!coachAiStatus().ready) return res.status(503).json({ code: 'not_configured', error: 'The English Coach is not set up yet. Please ask an admin.' })
    if (consent !== true) return res.status(400).json({ code: 'consent_required', error: 'Please agree to how your recording is processed first.' })

    const sc = getScenario(scenarioKey)
    if (!sc || (settings.disabledScenarios || []).includes(sc.key) || !canUseScenario(sc, req.userPermissions)) return res.status(400).json({ error: 'Choose one of the available scenarios.' })
    if (!DIFFICULTIES[difficulty]) return res.status(400).json({ error: 'Choose a difficulty.' })
    const minutes = Number(durationMin)
    if (!settings.durations.includes(minutes)) return res.status(400).json({ error: 'Choose one of the available call lengths.' })

    // A call left open whose time ran out: close it now rather than blocking a new one
    const existing = await CoachSession.findOne({ userId: req.userId, status: 'active' })
    if (existing && existing.endsAt.getTime() + TURN_GRACE_SEC * 1000 < Date.now()) {
      await finalizeSession(existing._id, 'expired')
    } else if (existing) {
      return res.status(409).json({ code: 'active_exists', sessionId: existing._id, error: 'You already have a practice call in progress.' })
    }

    const usage = await userUsage(req.userId, settings)
    if (usage.limit && usage.used >= usage.limit) {
      return res.status(429).json({ code: 'daily_limit', nextAvailableAt: usage.nextAvailableAt, error: `You can take ${usage.limit} practice tests in 24 hours.` })
    }
    if (await orgLimitReached(settings)) {
      return res.status(429).json({ code: 'org_limit', error: 'The academy\'s practice tests for today are used up. Please try again tomorrow.' })
    }

    const openings = sc.openings?.[difficulty] || sc.openings?.normal || ['Hello?']
    const now = new Date()
    let s
    try {
      s = await CoachSession.create({
        userId: req.userId,
        tutorId: req.user.linkedTutorId || undefined,
        scenarioKey: sc.key,
        scenario: {
          title: sc.title, summary: sc.summary, brief: sc.brief,
          personaName: sc.personaName, personaRole: sc.personaRole, initials: sc.initials,
          voice: sc.voice, lang: sc.lang, gender: sc.gender, goals: sc.goals,
          audience: audienceOf(sc), group: groupOf(sc), academyLines: sc.academyLines || [],
        },
        difficulty,
        durationSec: minutes * 60,
        startedAt: now,
        endsAt: new Date(now.getTime() + minutes * 60_000),
        consentAt: now,
        turns: [{ role: 'persona', text: openings[Math.floor(Math.random() * openings.length)], provider: 'script', at: now }],
      })
    } catch (err) {
      if (err?.code === 11000) {
        const other = await CoachSession.findOne({ userId: req.userId, status: 'active' }).select('_id').lean()
        return res.status(409).json({ code: 'active_exists', sessionId: other?._id, error: 'You already have a practice call in progress.' })
      }
      throw err
    }
    await s.populate('userId', 'displayName email')
    res.status(201).json({ session: sessionView(s) })
  } catch (err) {
    console.error('English Coach start:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function addTurn(req, res) {
  const clientTurnId = String(req.query.clientTurnId || '').slice(0, 64)
  let lockedAt = null
  let sessionId = null
  try {
    const s = await CoachSession.findById(req.params.id)
    if (!s || !isOwner(req, s)) return res.status(404).json({ error: 'Practice call not found' })
    sessionId = s._id

    // A retried upload of an answer that already landed: same reply again
    if (clientTurnId) {
      const i = s.turns.findIndex(t => t.role === 'tester' && t.clientTurnId === clientTurnId)
      if (i !== -1) {
        return res.json({
          tester: turnView(s.turns[i]),
          reply: s.turns[i + 1] ? turnView(s.turns[i + 1]) : null,
          remainingSec: Math.max(0, Math.round((s.endsAt - Date.now()) / 1000)),
          replayed: true,
          serverNow: new Date(),
        })
      }
    }

    if (s.status !== 'active') return res.status(409).json({ code: 'not_active', status: s.status, error: 'This practice call has ended.' })
    if (Date.now() > s.endsAt.getTime() + TURN_GRACE_SEC * 1000) {
      const out = await finalizeSession(s._id, 'time_up')
      await out?.session?.populate('userId', 'displayName email')
      return res.status(409).json({ code: 'time_up', session: out?.session ? sessionView(out.session) : null, error: 'Time is up for this call.' })
    }
    if (s.testerTurns >= MAX_TESTER_TURNS) return res.status(409).json({ code: 'turn_limit', error: 'This call has reached its limit of answers. Please end the call to see your score.' })

    const audio = req.body
    if (!Buffer.isBuffer(audio) || audio.length < MIN_AUDIO_BYTES) {
      return res.status(422).json({ code: 'no_speech', error: 'We didn\'t hear anything. Hold the button while you speak.' })
    }
    const mime = String(req.headers['content-type'] || '')
    if (!audioExtension(mime)) return res.status(415).json({ code: 'bad_audio', error: 'This browser recorded audio in a format we can\'t read. Please use Chrome or Edge.' })

    // Claim the call for this turn
    lockedAt = new Date()
    const claimed = await CoachSession.updateOne(
      { _id: s._id, status: 'active', $or: [{ busyAt: null }, { busyAt: { $lt: new Date(lockedAt - TURN_LOCK_STALE_MS) } }] },
      { $set: { busyAt: lockedAt } },
    )
    if (!claimed.modifiedCount) {
      lockedAt = null
      return res.status(409).json({ code: 'busy', error: 'Still working on your last answer…' })
    }

    const stt = await transcribe(audio, mime)
    const heard = turnMetrics(stt, Number(req.query.responseDelayMs))
    if (heard.noSpeech) {
      await CoachSession.updateOne({ _id: s._id, busyAt: lockedAt }, { $set: { busyAt: null } })
      lockedAt = null
      return res.status(422).json({ code: 'no_speech', error: 'We couldn\'t make out any words. Please try again a little closer to the microphone.' })
    }
    if ((heard.metrics.audioSec || 0) > MAX_TURN_AUDIO_SEC) {
      await CoachSession.updateOne({ _id: s._id, busyAt: lockedAt }, { $set: { busyAt: null } })
      lockedAt = null
      return res.status(422).json({ code: 'too_long', error: 'Please keep each answer under two minutes.' })
    }

    const testerTurn = { role: 'tester', text: heard.text, at: new Date(), clientTurnId: clientTurnId || undefined, metrics: heard.metrics }
    const remainingSec = Math.round((s.endsAt - Date.now()) / 1000)
    const draft = { scenarioKey: s.scenarioKey, scenario: s.scenario, difficulty: s.difficulty, turns: [...s.turns, testerTurn] }
    const reply = await personaReply(draft, remainingSec)
    const personaTurn = { role: 'persona', text: reply.text, at: new Date(), provider: reply.model ? `${reply.provider}/${reply.model}` : reply.provider }

    const saved = await CoachSession.updateOne(
      { _id: s._id, busyAt: lockedAt },
      {
        $push: { turns: { $each: [testerTurn, personaTurn] } },
        $inc: {
          testerTurns: 1,
          testerWords: heard.metrics.wordCount,
          'usage.audioSec': heard.metrics.audioSec || 0,
          'usage.promptTokens': reply.usage.promptTokens,
          'usage.completionTokens': reply.usage.completionTokens,
        },
        $set: { busyAt: null },
      },
    )
    lockedAt = null
    if (!saved.modifiedCount) return res.status(409).json({ code: 'busy', error: 'That answer arrived twice. Please continue.' })

    res.json({
      tester: turnView(testerTurn),
      reply: turnView(personaTurn),
      remainingSec: Math.max(0, remainingSec),
      serverNow: new Date(),
    })
  } catch (err) {
    if (lockedAt && sessionId) {
      await CoachSession.updateOne({ _id: sessionId, busyAt: lockedAt }, { $set: { busyAt: null } }).catch(() => {})
    }
    return aiErrorResponse(res, err)
  }
}

export async function finishSession(req, res) {
  try {
    const s = await CoachSession.findById(req.params.id).select('userId status')
    if (!s || !isOwner(req, s)) return res.status(404).json({ error: 'Practice call not found' })
    const reason = req.body?.reason === 'time_up' ? 'time_up' : 'ended_early'
    const out = await finalizeSession(s._id, reason)
    if (out?.busy) return res.status(409).json({ code: 'busy', error: 'Finishing your last answer…' })
    await out.session.populate('userId', 'displayName email')
    res.json({ session: sessionView(out.session) })
  } catch (err) {
    console.error('English Coach finish:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function listMine(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const q = { userId: req.userId, status: { $ne: 'abandoned' } }
    const [items, total] = await Promise.all([
      CoachSession.find(q).select('-turns').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      CoachSession.countDocuments(q),
    ])
    res.json({ items: items.map(summaryView), total, page, pages: Math.max(1, Math.ceil(total / limit)) })
  } catch (err) {
    console.error('English Coach mine:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getSession(req, res) {
  try {
    const s = await CoachSession.findById(req.params.id).populate('userId', 'displayName email').lean()
    if (!s || (!isOwner(req, s) && !has(req, 'coach.review'))) return res.status(404).json({ error: 'Practice call not found' })
    res.json({ session: sessionView(s), canReview: has(req, 'coach.review') && !isOwner(req, s) })
  } catch (err) {
    if (err?.name === 'CastError') return res.status(404).json({ error: 'Practice call not found' })
    console.error('English Coach get:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function rescoreSession(req, res) {
  try {
    const s = await CoachSession.findById(req.params.id).select('userId status')
    if (!s || (!isOwner(req, s) && !has(req, 'coach.review'))) return res.status(404).json({ error: 'Practice call not found' })
    if (s.status !== 'failed') return res.status(409).json({ error: 'Only a test whose marking failed can be marked again.' })
    await CoachSession.updateOne(
      { _id: s._id, status: 'failed' },
      { $set: { status: 'scoring', scoringAttempts: 0, scoringError: '', scoringLockAt: null } },
    )
    scoreSession(s._id).catch(err => console.error('English Coach rescore:', err.message))
    const fresh = await CoachSession.findById(s._id).populate('userId', 'displayName email').lean()
    res.json({ session: sessionView(fresh) })
  } catch (err) {
    console.error('English Coach rescore:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ── Reviewers ────────────────────────────────────────────────────────────────
function parseDate(v, endOfDay = false) {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) d.setUTCHours(23, 59, 59, 999)
  return d
}

export async function listSessions(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25))
    const q = {}
    if (req.query.userId && /^[a-f\d]{24}$/i.test(req.query.userId)) q.userId = req.query.userId
    if (req.query.scenario && SCENARIO_KEYS.includes(req.query.scenario)) q.scenarioKey = req.query.scenario
    if (req.query.difficulty && DIFFICULTIES[req.query.difficulty]) q.difficulty = req.query.difficulty
    const statuses = ['active', 'scoring', 'scored', 'failed', 'too_short', 'abandoned']
    q.status = statuses.includes(req.query.status) ? req.query.status : { $ne: 'abandoned' }
    if (req.query.reviewed === 'yes') q['review.at'] = { $exists: true }
    if (req.query.reviewed === 'no') q['review.at'] = { $exists: false }
    const from = parseDate(req.query.from)
    const to = parseDate(req.query.to, true)
    if (from || to) q.createdAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) }

    const sortable = { date: 'createdAt', score: 'result.overall' }
    const [field, dir] = String(req.query.sort || 'date:desc').split(':')
    const sort = { [sortable[field] || 'createdAt']: dir === 'asc' ? 1 : -1, _id: -1 }

    const [items, total] = await Promise.all([
      CoachSession.find(q).select('-turns').populate('userId', 'displayName email').sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      CoachSession.countDocuments(q),
    ])
    res.json({ items: items.map(summaryView), total, page, pages: Math.max(1, Math.ceil(total / limit)) })
  } catch (err) {
    console.error('English Coach list:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

/** Everyone who has taken a test — the people filter on the Team tab. */
export async function listPeople(req, res) {
  try {
    const ids = await CoachSession.distinct('userId', { status: { $ne: 'abandoned' } })
    const users = await User.find({ _id: { $in: ids } }).select('displayName email').sort({ displayName: 1 }).lean()
    res.json({ items: users.map(userView) })
  } catch (err) {
    console.error('English Coach people:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getOverview(req, res) {
  try {
    const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 90))
    const since = new Date(Date.now() - days * DAY_MS)
    const scored = { status: 'scored', createdAt: { $gte: since } }
    const areas = ['fluency', 'grammar', 'vocabulary', 'professionalism', 'clarity', 'handling']

    const [totals, perUser, weekly, byScenario, calibration, bands] = await Promise.all([
      CoachSession.aggregate([
        { $match: scored },
        {
          $group: {
            _id: null,
            tests: { $sum: 1 },
            testers: { $addToSet: '$userId' },
            overall: { $avg: '$result.overall' },
            ...Object.fromEntries(areas.map(a => [a, { $avg: `$result.scores.${a}` }])),
          },
        },
      ]),
      CoachSession.aggregate([
        { $match: scored },
        { $sort: { createdAt: 1 } },
        {
          $group: {
            _id: '$userId',
            tests: { $sum: 1 },
            avg: { $avg: '$result.overall' },
            best: { $max: '$result.overall' },
            first: { $first: '$result.overall' },
            last: { $last: '$result.overall' },
            lastAt: { $last: '$createdAt' },
            lastId: { $last: '$_id' },
            ...Object.fromEntries(areas.map(a => [a, { $avg: `$result.scores.${a}` }])),
          },
        },
        { $sort: { lastAt: -1 } },
        { $limit: 500 },
      ]),
      CoachSession.aggregate([
        { $match: scored },
        {
          $group: {
            _id: { $dateTrunc: { date: '$createdAt', unit: 'week', timezone: 'Asia/Karachi', startOfWeek: 'monday' } },
            tests: { $sum: 1 },
            avg: { $avg: '$result.overall' },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      CoachSession.aggregate([
        { $match: scored },
        { $group: { _id: '$scenarioKey', title: { $last: '$scenario.title' }, tests: { $sum: 1 }, avg: { $avg: '$result.overall' } } },
        { $sort: { tests: -1 } },
      ]),
      CoachSession.aggregate([
        { $match: { ...scored, 'review.score': { $type: 'number' } } },
        { $project: { diff: { $subtract: ['$result.overall', '$review.score'] } } },
        { $group: { _id: null, reviewed: { $sum: 1 }, meanDiff: { $avg: '$diff' }, meanAbsDiff: { $avg: { $abs: '$diff' } } } },
      ]),
      CoachSession.aggregate([
        { $match: scored },
        { $group: { _id: '$result.band', n: { $sum: 1 } } },
      ]),
    ])

    const users = await User.find({ _id: { $in: perUser.map(p => p._id) } }).select('displayName email').lean()
    const byId = new Map(users.map(u => [String(u._id), u]))
    const r = (n) => (Number.isFinite(n) ? Math.round(n) : null)
    const t = totals[0] || {}

    res.json({
      days,
      totals: {
        tests: t.tests || 0,
        testers: t.testers?.length || 0,
        overall: r(t.overall),
        areas: Object.fromEntries(areas.map(a => [a, r(t[a])])),
      },
      people: perUser.map(p => ({
        user: userView(byId.get(String(p._id))) || { id: p._id, name: 'Removed user' },
        tests: p.tests,
        avg: r(p.avg),
        best: r(p.best),
        first: r(p.first),
        last: r(p.last),
        change: p.tests > 1 ? r(p.last - p.first) : null,
        lastAt: p.lastAt,
        lastId: p.lastId,
        areas: Object.fromEntries(areas.map(a => [a, r(p[a])])),
      })),
      weekly: weekly.map(w => ({ week: w._id, tests: w.tests, avg: r(w.avg) })),
      scenarios: byScenario.map(s => ({ key: s._id, title: s.title, tests: s.tests, avg: r(s.avg) })),
      calibration: calibration[0]
        ? { reviewed: calibration[0].reviewed, meanDiff: Math.round(calibration[0].meanDiff * 10) / 10, meanAbsDiff: Math.round(calibration[0].meanAbsDiff * 10) / 10 }
        : { reviewed: 0, meanDiff: null, meanAbsDiff: null },
      bands: Object.fromEntries(bands.filter(b => b._id).map(b => [b._id, b.n])),
    })
  } catch (err) {
    console.error('English Coach overview:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function reviewSession(req, res) {
  try {
    const s = await CoachSession.findById(req.params.id)
    if (!s) return res.status(404).json({ error: 'Practice call not found' })
    if (isOwner(req, s)) return res.status(403).json({ error: 'Someone else needs to review your own test.' })
    if (s.status !== 'scored') return res.status(409).json({ error: 'Only a marked test can be reviewed.' })

    const { score, note } = req.body || {}
    let mark = null
    if (score !== null && score !== undefined && score !== '') {
      mark = Number(score)
      if (!Number.isFinite(mark) || mark < 0 || mark > 100) return res.status(400).json({ error: 'Your mark must be between 0 and 100.' })
      mark = Math.round(mark)
    }
    const text = String(note || '').trim().slice(0, 1500)
    if (mark == null && !text) return res.status(400).json({ error: 'Add a mark, a note, or both.' })

    const first = !s.review?.at
    s.review = { score: mark, note: text, by: req.userId, byName: req.user.displayName || req.user.email, at: new Date() }
    await s.save()
    if (first || text) {
      createNotification({
        userId: s.userId,
        type: 'coach_feedback',
        title: 'Feedback on your English practice',
        body: `${s.review.byName} reviewed your "${s.scenario?.title}" call.`,
        payload: { sessionId: String(s._id) },
      })
    }
    await s.populate('userId', 'displayName email')
    res.json({ session: sessionView(s.toObject()) })
  } catch (err) {
    console.error('English Coach review:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ── Managers ─────────────────────────────────────────────────────────────────
export async function deleteSession(req, res) {
  try {
    const s = await CoachSession.findByIdAndDelete(req.params.id).populate('userId', 'displayName email').lean()
    if (!s) return res.status(404).json({ error: 'Practice call not found' })
    logActivity({
      category: 'portal', action: 'english_coach_delete',
      message: `Deleted English practice test (${s.scenario?.title}) by ${s.userId?.displayName || s.userId?.email || s.userId}`,
      req, meta: { sessionId: String(s._id), overall: s.result?.overall ?? null },
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('English Coach delete:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

async function settingsView(settings) {
  const since = new Date(Date.now() - DAY_MS)
  const [day] = await CoachSession.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: null,
        started: { $sum: 1 },
        scored: { $sum: { $cond: [{ $eq: ['$status', 'scored'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        audioSec: { $sum: '$usage.audioSec' },
        tokens: { $sum: { $add: ['$usage.promptTokens', '$usage.completionTokens'] } },
      },
    },
  ])
  return {
    settings: {
      enabled: settings.enabled,
      durations: settings.durations,
      dailyLimitPerUser: settings.dailyLimitPerUser,
      orgDailyLimit: settings.orgDailyLimit,
      minTesterWords: settings.minTesterWords,
      disabledScenarios: settings.disabledScenarios,
      updatedAt: settings.updatedAt,
    },
    allowedDurations: ALLOWED_DURATIONS,
    scenarios: COACH_SCENARIOS.map(s => ({ key: s.key, title: s.title, summary: s.summary, personaName: s.personaName, group: groupOf(s), audience: audienceOf(s) })),
    groups: SCENARIO_GROUPS,
    ai: coachAiStatus(),
    last24h: day
      ? { started: day.started, scored: day.scored, failed: day.failed, audioMin: Math.round(day.audioSec / 6) / 10, tokens: day.tokens }
      : { started: 0, scored: 0, failed: 0, audioMin: 0, tokens: 0 },
  }
}

export async function getSettings(req, res) {
  try {
    res.json(await settingsView(await CoachSettings.getSettings()))
  } catch (err) {
    console.error('English Coach settings:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateSettings(req, res) {
  try {
    const b = req.body || {}
    const set = {}
    if ('enabled' in b) set.enabled = Boolean(b.enabled)
    if ('durations' in b) {
      const d = [...new Set((Array.isArray(b.durations) ? b.durations : []).map(Number))].filter(n => ALLOWED_DURATIONS.includes(n)).sort((x, y) => x - y)
      if (!d.length) return res.status(400).json({ error: 'Keep at least one call length.' })
      set.durations = d
    }
    const int = (k, lo, hi, label) => {
      if (!(k in b)) return null
      const n = Number(b[k])
      if (!Number.isInteger(n) || n < lo || n > hi) return `${label} must be a whole number from ${lo} to ${hi}.`
      set[k] = n
      return null
    }
    const bad = int('dailyLimitPerUser', 0, 50, 'Tests per person')
      || int('orgDailyLimit', 0, 1000, 'Tests for the academy')
      || int('minTesterWords', 10, 400, 'Minimum words')
    if (bad) return res.status(400).json({ error: bad })
    if ('disabledScenarios' in b) {
      const off = [...new Set((Array.isArray(b.disabledScenarios) ? b.disabledScenarios : []).filter(k => SCENARIO_KEYS.includes(k)))]
      if (off.length >= SCENARIO_KEYS.length) return res.status(400).json({ error: 'Keep at least one scenario switched on.' })
      set.disabledScenarios = off
    }
    set.updatedBy = req.userId
    await CoachSettings.getSettings()
    const settings = await CoachSettings.findOneAndUpdate({ key: 'default' }, { $set: set }, { new: true })
    logActivity({ category: 'portal', action: 'english_coach_settings', message: 'Updated English Coach settings', req, meta: set })
    res.json(await settingsView(settings))
  } catch (err) {
    console.error('English Coach settings update:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

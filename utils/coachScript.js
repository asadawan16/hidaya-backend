/*
 * English Coach — scripted role-plays (the Role-Play Practice Book).
 *
 * In a scripted call the character's words never come from an AI: the tester
 * says the teacher's line from the book, the server checks how close it was,
 * and the book's next student / parent line is played back. These are the
 * pure helpers for that (no I/O) — scripts/smoke-english-coach.mjs tests them
 * directly.
 *
 * How close a line was = word-level LCS (longest common subsequence) F-score
 * between what Whisper heard and the book's sentence, after normalising the
 * things that differ without the tester having said anything different:
 * contractions ("let's" = "let us"), spellings of Arabic words (Assalamu
 * Alaikum, InshaAllah, Ghunnah…), British/American spelling, digits and
 * hesitations. Word ORDER counts, as it does in the book ("How you are" is not
 * "How are you").
 */
import { BOOK_SPEAKERS } from '../config/coachRolePlays.js'
import { isFiller } from './coachMetrics.js'

// The share of the book's sentence a line must match to count, per difficulty
export const SCRIPT_PASS = { very_easy: 0.5, easy: 0.6, normal: 0.65, hard: 0.75 }
// Attempts at one line: a miss shows the book's line and asks again; a second
// miss moves the call on (the line is marked as missed), as a partner would
export const SCRIPT_MAX_TRIES = 2

const CONTRACTIONS = [
  [/\blet's\b/g, 'let us'], [/\bdon't\b/g, 'do not'], [/\bdoesn't\b/g, 'does not'], [/\bdidn't\b/g, 'did not'],
  [/\bcan't\b/g, 'cannot'], [/\bcan not\b/g, 'cannot'], [/\bwon't\b/g, 'will not'], [/\bisn't\b/g, 'is not'],
  [/\baren't\b/g, 'are not'], [/\bwasn't\b/g, 'was not'], [/\bi'm\b/g, 'i am'], [/\byou're\b/g, 'you are'],
  [/\bwe're\b/g, 'we are'], [/\bthey're\b/g, 'they are'], [/\bit's\b/g, 'it is'], [/\bthat's\b/g, 'that is'],
  [/\bwhat's\b/g, 'what is'], [/\bthere's\b/g, 'there is'], [/\bhere's\b/g, 'here is'], [/\bi'll\b/g, 'i will'],
  [/\bwe'll\b/g, 'we will'], [/\byou'll\b/g, 'you will'], [/\bi've\b/g, 'i have'], [/\bwe've\b/g, 'we have'],
  [/\bi'd\b/g, 'i would'], [/\bshouldn't\b/g, 'should not'], [/\bcouldn't\b/g, 'could not'],
]

// Applied to the punctuation-free, space-joined text
const PHRASES = [
  [/\bwa ?a?l+a+[iy]?k+[uo]+m+ ?(?:a+s+ ?)?s?a+l+a+a?m+[uo]?\b/g, 'wa alaikum assalam'],
  [/\ba+s+ ?s?a+l+a+a?m+ ?(?:u|o|ou)? ?a?l+a+[iy]?[ei]?k+[uo]+m+\b/g, 'assalamu alaikum'],
  [/\bin ?sha+ ?a?l+a+h\b/g, 'inshaallah'],
  [/\bma ?sha+ ?a?l+a+h\b/g, 'mashaallah'],
  [/\bal ?hamdu ?li ?l+a+h\b/g, 'alhamdulillah'],
  [/\bbis+ ?mil+a+h\b/g, 'bismillah'],
  [/\bpractis(e|ed|es|ing)\b/g, 'practic$1'],
]

const WORDS = {
  ok: 'okay', ahmed: 'ahmad', sarah: 'sara', duaa: 'dua', ayat: 'ayah', aya: 'ayah', aayah: 'ayah',
  mad: 'madd', ghunna: 'ghunnah', gunna: 'ghunnah', gunnah: 'ghunnah', kalima: 'kalimah', kalma: 'kalimah',
  shadda: 'shaddah', shada: 'shaddah', tajwid: 'tajweed', koran: 'quran', haraka: 'harakah', harakat: 'harakah',
  qaeda: 'qaida', qaidah: 'qaida', colour: 'color', recognise: 'recognize',
  1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten',
}

/** A sentence → the words compared (lower-case, normalised, no hesitations). */
export function matchTokens(s) {
  let x = String(s || '').toLowerCase().replace(/[’‘`´]/g, '\'')
  for (const [re, to] of CONTRACTIONS) x = x.replace(re, to)
  x = x.replace(/'/g, '').replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim()
  for (const [re, to] of PHRASES) x = x.replace(re, to)
  return x.split(' ').filter(Boolean).map(w => WORDS[w] || w).filter(w => !isFiller(w))
}

function lcsLength(a, b) {
  const prev = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diag = 0
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1])
      diag = up
    }
  }
  return prev[b.length]
}

/** 0–1: how closely what was said follows the book's sentence. */
export function scriptMatch(said, expected) {
  const a = matchTokens(said)
  const b = matchTokens(expected)
  if (!a.length || !b.length) return 0
  return (2 * lcsLength(a, b)) / (a.length + b.length)
}

export const passMark = (difficulty) => SCRIPT_PASS[difficulty] ?? SCRIPT_PASS.normal

/**
 * One unit of the book → what a session stores: the role plays it covers and
 * the flattened lines from `startPlay` on. Persona lines carry the speaker key
 * (BOOK_SPEAKERS) whose voice says them.
 */
export function buildScript(unit, startPlay = 0) {
  const from = Math.min(Math.max(0, Number(startPlay) || 0), unit.plays.length - 1)
  const plays = unit.plays.slice(from)
  const steps = []
  const used = new Set()
  plays.forEach((p, i) => {
    for (const [who, text] of p.lines) {
      if (who === 'T') { steps.push({ play: i, who, text }); continue }
      const speaker = who === 'P' ? 'P' : (p.student || 'S')
      used.add(speaker)
      steps.push({ play: i, who, speaker, text })
    }
  })
  return {
    unit: unit.unit,
    unitTitle: unit.title,
    startPlay: from,
    plays: plays.map(p => ({ n: p.n, title: p.title, goal: p.goal })),
    steps,
    speakers: Object.fromEntries([...used].map(k => [k, BOOK_SPEAKERS[k]])),
  }
}

export const teacherSteps = (script) => (script?.steps || []).reduce((n, s) => n + (s.who === 'T' ? 1 : 0), 0)

/** The character lines from `pos` up to the next teacher line → { lines, next }. */
export function personaRun(script, pos) {
  const steps = script?.steps || []
  const lines = []
  let i = pos
  while (i < steps.length && steps[i].who !== 'T') {
    // Field by field: a stored script's steps are Mongoose subdocuments
    const { play, who, speaker, text } = steps[i]
    lines.push({ play, who, speaker, text, step: i })
    i++
  }
  return { lines, next: i }
}

/**
 * Line by line: each teacher line the tester reached, every attempt at it and
 * how it went. Lines never reached (time ran out) are left out.
 */
export function scriptLines(script, turns) {
  const steps = script?.steps || []
  const byStep = new Map()
  for (const t of turns || []) {
    if (t.role !== 'tester' || !t.check || !Number.isInteger(t.check.step)) continue
    const list = byStep.get(t.check.step) || []
    list.push({ text: t.text, match: t.check.match, passed: Boolean(t.check.passed) })
    byStep.set(t.check.step, list)
  }
  return [...byStep.entries()].sort((a, b) => a[0] - b[0]).map(([step, attempts]) => {
    const s = steps[step] || {}
    const best = Math.max(...attempts.map(a => a.match || 0))
    return {
      step,
      play: s.play,
      expected: s.text || '',
      attempts,
      passed: attempts.some(a => a.passed),
      firstTime: Boolean(attempts[0]?.passed),
      best: Math.round(best * 100) / 100,
    }
  })
}

/**
 * The deterministic "handling" mark for a scripted call: how accurately the
 * tester said the book's lines. Right first time scores its match; right on
 * the second try loses 15; never right scores half its best match.
 */
export function scriptScore(script, turns) {
  const lines = scriptLines(script, turns)
  const total = teacherSteps(script)
  if (!lines.length) return { total, attempted: 0, firstTime: 0, passed: 0, accuracy: null, score: null, lines }
  const lineScore = (l) => {
    if (l.firstTime) return l.attempts[0].match * 100
    if (l.passed) return Math.max(0, (l.attempts.find(a => a.passed)?.match || 0) - 0.15) * 100
    return l.best * 50
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    total,
    attempted: lines.length,
    firstTime: lines.filter(l => l.firstTime).length,
    passed: lines.filter(l => l.passed).length,
    accuracy: Math.round(mean(lines.map(l => l.best)) * 100),
    score: Math.round(Math.min(100, Math.max(0, mean(lines.map(lineScore))))),
    lines,
  }
}

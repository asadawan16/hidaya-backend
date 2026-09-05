// Smoke test for the public class-links board (/class-links) + its portal CRUD.
// Connects straight to Mongo (no running server needed) and drives the real
// controllers with mock req/res objects, then cleans up everything it created.
//
//   node scripts/smoke-class-links.mjs
import 'dotenv/config'
import mongoose from 'mongoose'
import TutorProfile from '../models/TutorProfile.js'
import ClassLink from '../models/ClassLink.js'
import ClassLinkSettings from '../models/ClassLinkSettings.js'
import {
  createClassLink, updateClassLink, deleteClassLink, listClassLinks,
  updateClassLinkSettings,
} from '../controllers/portalClassLinkController.js'
import { getPublicClassLinks, trackClassLinkClick } from '../controllers/publicClassLinkController.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// Minimal express req/res doubles — capture status + json payload.
const mockRes = () => {
  const res = { statusCode: 200, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  return res
}
const call = async (handler, req = {}) => {
  const res = mockRes()
  await handler({ query: {}, params: {}, body: {}, ...req }, res)
  return res
}

await mongoose.connect(process.env.MONGODB_URI)
console.log('Connected.\n')

const tutor = await TutorProfile.findOne().select('name').lean()
if (!tutor) {
  console.error('No tutor found — seed tutors first (node seedClientDemo.js).')
  await mongoose.disconnect()
  process.exit(1)
}

// Remember the real settings so the smoke run never leaves the page altered.
const original = await ClassLinkSettings.getSettings()
const restore = {
  headline: original.headline,
  subheadline: original.subheadline,
  accessCode: original.accessCode,
  isPublished: original.isPublished,
}

let createdId = null
try {
  // ── create ────────────────────────────────────────────────────────────────
  const created = await call(createClassLink, {
    body: {
      tutorId: String(tutor._id),
      url: 'meet.google.com/smoke-test-abc',  // no scheme — should be normalized
      label: 'Smoke Test Batch',
      platform: 'google_meet',
      note: 'Smoke test note',
    },
  })
  createdId = created.body?._id
  check('create returns 201', created.statusCode === 201, `got ${created.statusCode}`)
  check('bare URL gets https://', created.body?.url === 'https://meet.google.com/smoke-test-abc', created.body?.url)
  check('tutor name snapshotted', created.body?.tutorName === tutor.name, created.body?.tutorName)

  const missing = await call(createClassLink, { body: { tutorId: String(tutor._id) } })
  check('create without a url is rejected', missing.statusCode === 400)

  // ── portal list ───────────────────────────────────────────────────────────
  const listed = await call(listClassLinks, { query: { search: 'Smoke Test' } })
  check('portal list finds it by search', listed.body?.records?.some(r => String(r._id) === String(createdId)))

  // ── public feed (open) ────────────────────────────────────────────────────
  await call(updateClassLinkSettings, { body: { accessCode: '', isPublished: true }, userId: null })
  const open = await call(getPublicClassLinks)
  const card = open.body?.links?.find(l => l.id === String(createdId))
  check('public feed lists the active link', Boolean(card))
  check('card carries name + url', card?.tutorName === tutor.name && Boolean(card?.url))
  check('card has a theme index', Number.isInteger(card?.theme))
  check('public payload leaks no tutor contact fields',
    card && !('email' in card) && !('phone' in card) && !('tutorId' in card))

  // ── hidden links stay off the public feed ────────────────────────────────
  await call(updateClassLink, { params: { id: createdId }, body: { isActive: false } })
  const hidden = await call(getPublicClassLinks)
  check('hidden link disappears publicly', !hidden.body?.links?.some(l => l.id === String(createdId)))
  await call(updateClassLink, { params: { id: createdId }, body: { isActive: true } })

  // ── access code gate ──────────────────────────────────────────────────────
  await call(updateClassLinkSettings, { body: { accessCode: 'SMOKE123' }, userId: null })
  const noCode = await call(getPublicClassLinks)
  check('gate hides links without a code', noCode.body?.requiresCode === true && noCode.body?.links?.length === 0)

  const wrongCode = await call(getPublicClassLinks, { query: { code: 'NOPE' } })
  check('wrong code is flagged', wrongCode.body?.invalidCode === true && wrongCode.body?.links?.length === 0)

  const rightCode = await call(getPublicClassLinks, { query: { code: 'smoke123' } })  // case-insensitive
  check('correct code unlocks the board', rightCode.body?.unlocked === true && rightCode.body?.links?.length > 0)

  // ── master publish switch ────────────────────────────────────────────────
  await call(updateClassLinkSettings, { body: { accessCode: '', isPublished: false }, userId: null })
  const offline = await call(getPublicClassLinks)
  check('unpublished page returns no links', offline.body?.published === false && offline.body?.links?.length === 0)
  await call(updateClassLinkSettings, { body: { isPublished: true }, userId: null })

  // ── click tracking ────────────────────────────────────────────────────────
  const before = (await ClassLink.findById(createdId).select('clicks').lean())?.clicks || 0
  await call(trackClassLinkClick, { params: { id: createdId } })
  const after = (await ClassLink.findById(createdId).select('clicks').lean())?.clicks || 0
  check('join click increments the counter', after === before + 1, `${before} → ${after}`)

  // ── delete ────────────────────────────────────────────────────────────────
  const removed = await call(deleteClassLink, { params: { id: createdId } })
  check('delete succeeds', removed.statusCode === 200)
  createdId = null
} finally {
  if (createdId) await ClassLink.findByIdAndDelete(createdId)
  const settings = await ClassLinkSettings.getSettings()
  Object.assign(settings, restore)
  await settings.save()
  console.log('\nSettings restored to their original values.')
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
await mongoose.disconnect()
process.exit(failures === 0 ? 0 : 1)

/*
 * Backfill per-response and overall scores on assessments recorded before the
 * scoring rules existed (they all stored `overallScore: null`, so reports and
 * the student-progress page showed "—"). Idempotent — safe to re-run.
 *
 *   node scripts/migrate-assessment-scores.mjs
 */
import 'dotenv/config'
import mongoose from 'mongoose'
import Assessment from '../models/Assessment.js'
import AssessmentTemplate from '../models/AssessmentTemplate.js'
import { scoreAssessment } from '../utils/assessmentScore.js'

const uri = process.env.MONGODB_URI
if (!uri) { console.error('MONGODB_URI missing'); process.exit(1) }

await mongoose.connect(uri)

const templates = new Map(
  (await AssessmentTemplate.find().lean()).map(t => [String(t._id), t]),
)

let updated = 0, skipped = 0
for (const a of await Assessment.find().lean()) {
  const template = templates.get(String(a.templateId))
  const { responses, overallScore } = scoreAssessment(template, a.responses || [])
  if (overallScore == null) { skipped++; continue }
  await Assessment.updateOne({ _id: a._id }, { $set: { responses, overallScore } })
  updated++
}

console.log(`Assessments scored: ${updated} · unscoreable (text-only / no responses): ${skipped}`)
await mongoose.disconnect()

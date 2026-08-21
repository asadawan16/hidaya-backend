// Rebuild the salaryrecords uniqueness index on tutorId.
//
// The legacy index was a plain unique { tutorId, year, month } — created before
// staff/custom salary subjects existed. Those records have NO tutorId, so every
// staff/custom row for a period collides on `tutorId: null` and the second
// generate of any month fails with E11000 (surfaced in the UI as "Server error").
//
// The model declares a partial index (`tutorId: { $exists: true }`); MongoDB will
// not silently change an existing index's options, so it has to be dropped and
// recreated once. Idempotent — safe to re-run.
import 'dotenv/config'
import mongoose from 'mongoose'

const NAME = 'tutorId_1_year_1_month_1'

async function main() {
  await mongoose.connect(process.env.MONGODB_URI)
  const col = mongoose.connection.db.collection('salaryrecords')

  const before = await col.indexes()
  const existing = before.find(i => i.name === NAME)

  if (!existing) {
    console.log(`No ${NAME} index found — creating it.`)
  } else if (existing.partialFilterExpression?.tutorId?.$exists === true) {
    console.log(`✓ ${NAME} already partial — nothing to do.`)
    await mongoose.disconnect()
    return
  } else {
    console.log(`Dropping legacy non-partial index ${NAME}…`)
    await col.dropIndex(NAME)
  }

  await col.createIndex(
    { tutorId: 1, year: 1, month: 1 },
    { unique: true, background: true, partialFilterExpression: { tutorId: { $exists: true } } },
  )
  console.log(`✓ Recreated ${NAME} with partialFilterExpression { tutorId: { $exists: true } }`)

  // Sanity check: no duplicate tutor records slipped through while unindexed.
  const dupes = await col.aggregate([
    { $match: { tutorId: { $exists: true, $ne: null } } },
    { $group: { _id: { t: '$tutorId', y: '$year', m: '$month' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray()
  if (dupes.length) console.warn(`⚠ ${dupes.length} duplicate tutor salary period(s) found:`, dupes)

  console.log(JSON.stringify(await col.indexes(), null, 2))
  await mongoose.disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await mongoose.disconnect()
  process.exit(1)
})

import 'dotenv/config'
import mongoose from 'mongoose'

await mongoose.connect(process.env.MONGODB_URI)
const db = mongoose.connection.db
console.log('DB name:', db.databaseName)

const stats = await db.stats()
const mb = (b) => (b / (1024 * 1024))
console.log('\n=== DB TOTALS ===')
console.log('dataSize   :', mb(stats.dataSize).toFixed(2), 'MB (uncompressed logical)')
console.log('storageSize:', mb(stats.storageSize).toFixed(2), 'MB (compressed on disk)')
console.log('indexSize  :', mb(stats.indexSize).toFixed(2), 'MB')
console.log('total(store+index):', mb(stats.storageSize + stats.indexSize).toFixed(2), 'MB')
console.log('objects    :', stats.objects)

const cols = await db.listCollections().toArray()
const rows = []
for (const { name } of cols) {
  const cs = await db.command({ collStats: name })
  rows.push({
    name,
    count: cs.count,
    dataMB: mb(cs.size),
    storeMB: mb(cs.storageSize),
    idxMB: mb(cs.totalIndexSize),
    totalMB: mb(cs.storageSize + cs.totalIndexSize),
  })
}
rows.sort((a, b) => b.totalMB - a.totalMB)
console.log('\n=== TOP COLLECTIONS (by store+index MB) ===')
console.log('collection'.padEnd(28), 'count'.padStart(8), 'data'.padStart(9), 'store'.padStart(9), 'index'.padStart(9), 'total'.padStart(9))
for (const r of rows.slice(0, 25)) {
  console.log(
    r.name.padEnd(28),
    String(r.count).padStart(8),
    r.dataMB.toFixed(2).padStart(9),
    r.storeMB.toFixed(2).padStart(9),
    r.idxMB.toFixed(2).padStart(9),
    r.totalMB.toFixed(2).padStart(9),
  )
}
await mongoose.disconnect()

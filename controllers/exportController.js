import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { ZipArchive } = require('archiver')
const XLSX = require('xlsx')

import Student from '../models/Student.js'
import Payment from '../models/Payment.js'
import PaymentLink from '../models/PaymentLink.js'
import Enrollment from '../models/Enrollment.js'
import Subscriber from '../models/Subscriber.js'
import BlogPost from '../models/BlogPost.js'
import Plan from '../models/Plan.js'
import Admin from '../models/Admin.js'

const collections = [
  { name: 'Students', model: Student },
  { name: 'Payments', model: Payment },
  { name: 'PaymentLinks', model: PaymentLink },
  { name: 'Enrollments', model: Enrollment },
  { name: 'Subscribers', model: Subscriber },
  { name: 'BlogPosts', model: BlogPost },
  { name: 'Plans', model: Plan },
]

/* ── Broadcast progress to all connected WS clients for this export ── */
function broadcast(wss, adminId, data) {
  if (!wss) return
  for (const client of wss.clients) {
    if (client.readyState === 1 && client._adminId === adminId) {
      client.send(JSON.stringify(data))
    }
  }
}

/* ── Export all database data as zip ── */
export async function exportDatabase(req, res) {
  const wss = req.app.get('wss')
  const adminId = req.adminId

  try {
    broadcast(wss, adminId, { type: 'start', message: 'Starting database export...' })

    const totalSteps = collections.length * 2 + 2 // fetch + excel per collection + json bundle + zip
    let completedSteps = 0

    const sendProgress = (step, detail) => {
      completedSteps++
      const pct = Math.round((completedSteps / totalSteps) * 100)
      broadcast(wss, adminId, { type: 'progress', step, detail, pct })
    }

    // 1. Fetch all collections
    const allData = {}
    for (const col of collections) {
      const docs = await col.model.find().lean()
      allData[col.name] = docs
      sendProgress('fetch', `Fetched ${docs.length} ${col.name.toLowerCase()}`)
    }

    // 2. Build Excel workbook
    broadcast(wss, adminId, { type: 'progress', step: 'excel', detail: 'Building Excel workbook...', pct: Math.round((completedSteps / totalSteps) * 100) })
    const wb = XLSX.utils.book_new()

    for (const col of collections) {
      const docs = allData[col.name]
      if (docs.length === 0) {
        // Add empty sheet with headers from schema
        const ws = XLSX.utils.json_to_sheet([])
        XLSX.utils.book_append_sheet(wb, ws, col.name)
      } else {
        // Flatten objects for Excel (convert _id, dates, nested objects to strings)
        const flat = docs.map(doc => {
          const row = {}
          for (const [key, val] of Object.entries(doc)) {
            if (key === '__v') continue
            if (val instanceof Date) row[key] = val.toISOString()
            else if (val && typeof val === 'object' && val._bsontype) row[key] = val.toString()
            else if (Array.isArray(val)) row[key] = JSON.stringify(val)
            else if (val && typeof val === 'object') row[key] = JSON.stringify(val)
            else row[key] = val
          }
          return row
        })
        const ws = XLSX.utils.json_to_sheet(flat)
        // Auto-size columns
        const colWidths = Object.keys(flat[0] || {}).map(key => ({
          wch: Math.max(key.length, ...flat.slice(0, 50).map(r => String(r[key] || '').length)).toString().length > 40 ? 40 : Math.max(key.length + 2, 12)
        }))
        ws['!cols'] = colWidths
        XLSX.utils.book_append_sheet(wb, ws, col.name.slice(0, 31)) // Excel max sheet name 31 chars
      }
      sendProgress('excel', `Added ${col.name} sheet (${docs.length} rows)`)
    }

    const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

    // 3. Build JSON bundle
    sendProgress('json', 'Building JSON files...')
    const jsonData = {}
    for (const col of collections) {
      jsonData[col.name] = allData[col.name]
    }

    // 4. Create ZIP
    broadcast(wss, adminId, { type: 'progress', step: 'zip', detail: 'Creating ZIP archive...', pct: 95 })

    const timestamp = new Date().toISOString().slice(0, 10)

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="hidaya-export-${timestamp}.zip"`)

    const archive = new ZipArchive({ zlib: { level: 6 } })
    archive.pipe(res)

    // Add Excel file
    archive.append(excelBuffer, { name: `hidaya-database-${timestamp}.xlsx` })

    // Add individual JSON files per collection
    for (const col of collections) {
      archive.append(JSON.stringify(allData[col.name], null, 2), { name: `json/${col.name.toLowerCase()}.json` })
    }

    // Add combined JSON
    archive.append(JSON.stringify(jsonData, null, 2), { name: `json/all-data.json` })

    // Add export metadata
    const meta = {
      exportedAt: new Date().toISOString(),
      collections: collections.map(c => ({ name: c.name, count: allData[c.name].length })),
      totalRecords: Object.values(allData).reduce((sum, arr) => sum + arr.length, 0),
    }
    archive.append(JSON.stringify(meta, null, 2), { name: 'export-info.json' })

    archive.on('end', () => {
      broadcast(wss, adminId, { type: 'complete', message: 'Export complete!', meta })
    })

    archive.on('error', (err) => {
      broadcast(wss, adminId, { type: 'error', message: err.message })
    })

    sendProgress('zip', 'Finalizing archive...')
    await archive.finalize()

    // Update last export date
    await Admin.findByIdAndUpdate(adminId, { lastExportAt: new Date() })

  } catch (err) {
    console.error('Export error:', err)
    broadcast(wss, adminId, { type: 'error', message: err.message })
    if (!res.headersSent) {
      res.status(500).json({ error: 'Export failed' })
    }
  }
}

/* ── Get export status (last export date) ── */
export async function getExportStatus(req, res) {
  try {
    const admin = await Admin.findById(req.adminId).select('lastExportAt')
    res.json({ lastExportAt: admin?.lastExportAt || null })
  } catch (err) {
    console.error('Export status error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

import CurriculumItem from '../models/CurriculumItem.js'
import { logActivity } from '../utils/activityLogger.js'

export async function listCurriculum(req, res) {
  try {
    const { track, parentId, flat } = req.query

    const filter = { active: true }
    if (track) filter.track = track

    if (flat === 'true') {
      // Return flat list
      const items = await CurriculumItem.find(filter).sort({ track: 1, order: 1 }).lean()
      return res.json(items)
    }

    // Return tree: top-level items (parentId: null) for a given track
    if (parentId) {
      filter.parentId = parentId
    } else {
      filter.parentId = null
    }

    const items = await CurriculumItem.find(filter).sort({ order: 1 }).lean()

    // For each item, count children
    const ids = items.map(i => i._id)
    const childCounts = await CurriculumItem.aggregate([
      { $match: { parentId: { $in: ids }, active: true } },
      { $group: { _id: '$parentId', count: { $sum: 1 } } },
    ])
    const countMap = {}
    childCounts.forEach(c => { countMap[c._id.toString()] = c.count })

    const enriched = items.map(item => ({
      ...item,
      childCount: countMap[item._id.toString()] || 0,
    }))

    res.json(enriched)
  } catch (err) {
    console.error('List curriculum error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getCurriculumItem(req, res) {
  try {
    const item = await CurriculumItem.findById(req.params.id)
      .populate('parentId', 'label track type')
      .lean()

    if (!item) return res.status(404).json({ error: 'Item not found' })

    // Get children
    const children = await CurriculumItem.find({ parentId: item._id, active: true })
      .sort({ order: 1 }).lean()

    res.json({ ...item, children })
  } catch (err) {
    console.error('Get curriculum item error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createCurriculumItem(req, res) {
  try {
    const { track, type, label, parentId, order, meta } = req.body

    if (!track || !type || !label) {
      return res.status(400).json({ error: 'Track, type, and label are required' })
    }

    // Auto-set order if not provided
    let finalOrder = order
    if (finalOrder === undefined) {
      const last = await CurriculumItem.findOne({ parentId: parentId || null, track })
        .sort({ order: -1 }).select('order').lean()
      finalOrder = (last?.order || 0) + 1
    }

    const item = await CurriculumItem.create({
      track,
      type,
      label: label.trim(),
      parentId: parentId || null,
      order: finalOrder,
      meta: meta || {},
      active: true,
    })

    await logActivity({
      level: 'info',
      category: 'curriculum',
      action: 'curriculum_item_created',
      message: `Curriculum item created: ${item.label} (${item.track})`,
      req,
      meta: { itemId: item._id },
    })

    res.status(201).json(item)
  } catch (err) {
    console.error('Create curriculum item error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateCurriculumItem(req, res) {
  try {
    const item = await CurriculumItem.findById(req.params.id)
    if (!item) return res.status(404).json({ error: 'Item not found' })

    const allowedFields = ['label', 'type', 'order', 'meta', 'active', 'parentId']
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        item[field] = req.body[field]
      }
    }

    await item.save()

    await logActivity({
      level: 'info',
      category: 'curriculum',
      action: 'curriculum_item_updated',
      message: `Curriculum item updated: ${item.label}`,
      req,
      meta: { itemId: item._id },
    })

    res.json(item)
  } catch (err) {
    console.error('Update curriculum item error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteCurriculumItem(req, res) {
  try {
    const item = await CurriculumItem.findById(req.params.id)
    if (!item) return res.status(404).json({ error: 'Item not found' })

    // Soft delete — mark as inactive
    item.active = false
    await item.save()

    // Also deactivate children
    await CurriculumItem.updateMany({ parentId: item._id }, { active: false })

    await logActivity({
      level: 'warning',
      category: 'curriculum',
      action: 'curriculum_item_deleted',
      message: `Curriculum item deactivated: ${item.label}`,
      req,
      meta: { itemId: item._id },
    })

    res.json({ message: 'Item deactivated' })
  } catch (err) {
    console.error('Delete curriculum item error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getCurriculumStats(req, res) {
  try {
    const stats = await CurriculumItem.aggregate([
      { $match: { active: true } },
      { $group: { _id: '$track', count: { $sum: 1 } } },
    ])

    const total = await CurriculumItem.countDocuments({ active: true })

    res.json({ total, trackStats: stats })
  } catch (err) {
    console.error('Curriculum stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function seedCurriculum(req, res) {
  try {
    const existing = await CurriculumItem.countDocuments()
    if (existing > 0) {
      return res.status(400).json({ error: 'Curriculum already has items. Clear first or skip seeding.' })
    }

    const items = []

    // Qaida — 31 pages
    for (let p = 1; p <= 31; p++) {
      items.push({ track: 'qaida', type: 'page', label: `Qaida Page ${p}`, order: p, meta: { pageNumber: p } })
    }

    // 6 Kalimas
    const kalimas = ['Tayyab', 'Shahadat', 'Tamjeed', 'Tawheed', 'Astaghfar', 'Radde Kufr']
    kalimas.forEach((k, i) => {
      items.push({ track: 'kalima', type: 'kalima', label: `Kalima ${i + 1} — ${k}`, order: i + 1 })
    })

    // 30 Duas
    const duaLabels = [
      'Before Eating', 'After Eating', 'Before Sleeping', 'After Waking Up',
      'Entering Masjid', 'Leaving Masjid', 'Before Wudu', 'After Wudu',
      'Entering Bathroom', 'Leaving Bathroom', 'Travelling', 'Before Studying',
      'After Studying', 'For Parents', 'Before Mirror', 'Wearing Clothes',
      'Removing Clothes', 'Entering Home', 'Leaving Home', 'Drinking Water',
      'After Drinking Water', 'Sneezing', 'Before Drinking Milk', 'Istikhara',
      'Qunoot', 'Janazah', 'Rain', 'Thunder', 'Safar', 'Gatherings',
    ]
    duaLabels.forEach((d, i) => {
      items.push({ track: 'dua', type: 'dua', label: `Dua #${i + 1} — ${d}`, order: i + 1 })
    })

    // Namaz components
    const namazParts = [
      'Niyyah', 'Takbeer-e-Tahreema', 'Sana', 'Taawwuz', 'Tasmiyah',
      'Surah Fatiha', 'Ruku', 'Qawmah', 'Sajdah', 'Jalsah',
      'Attahiyat', 'Durood Ibrahim', 'Dua after Durood', 'Salam',
      'Dua-e-Qunoot', 'Witr',
    ]
    namazParts.forEach((p, i) => {
      items.push({ track: 'namaz', type: 'component', label: p, order: i + 1 })
    })

    // Quran — 30 Paras
    for (let p = 1; p <= 30; p++) {
      items.push({ track: 'quran', type: 'para', label: `Para ${p}`, order: p, meta: { paraNumber: p } })
    }

    // Hifz — 114 Surahs (abbreviated top surahs)
    const topSurahs = [
      'Al-Fatihah', 'Al-Baqarah', 'Aal-e-Imran', 'An-Nisa', 'Al-Maidah',
      'Al-Anam', 'Al-Araf', 'Al-Anfal', 'At-Taubah', 'Yunus',
    ]
    // Short surahs for Hifz from Juz Amma
    const juzAmmaSurahs = [
      'An-Naba', 'An-Naziat', 'Abasa', 'At-Takwir', 'Al-Infitar',
      'Al-Mutaffifin', 'Al-Inshiqaq', 'Al-Buruj', 'At-Tariq', 'Al-Ala',
      'Al-Ghashiyah', 'Al-Fajr', 'Al-Balad', 'Ash-Shams', 'Al-Lail',
      'Ad-Duha', 'Al-Inshirah', 'At-Tin', 'Al-Alaq', 'Al-Qadr',
      'Al-Bayyinah', 'Az-Zalzalah', 'Al-Adiyat', 'Al-Qariah', 'At-Takathur',
      'Al-Asr', 'Al-Humazah', 'Al-Fil', 'Quraish', 'Al-Maun',
      'Al-Kawthar', 'Al-Kafirun', 'An-Nasr', 'Al-Masad', 'Al-Ikhlas',
      'Al-Falaq', 'An-Nas',
    ]
    topSurahs.forEach((s, i) => {
      items.push({ track: 'hifz', type: 'surah', label: `Surah ${s}`, order: i + 1, meta: { surahNumber: i + 1 } })
    })
    juzAmmaSurahs.forEach((s, i) => {
      items.push({ track: 'hifz', type: 'surah', label: `Surah ${s}`, order: 78 + i, meta: { surahNumber: 78 + i } })
    })

    await CurriculumItem.insertMany(items)

    await logActivity({
      level: 'info',
      category: 'curriculum',
      action: 'curriculum_seeded',
      message: `Curriculum seeded with ${items.length} items`,
      req,
    })

    res.json({ message: `Seeded ${items.length} curriculum items` })
  } catch (err) {
    console.error('Seed curriculum error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

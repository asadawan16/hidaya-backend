import ClassLink from '../models/ClassLink.js'
import ClassLinkSettings from '../models/ClassLinkSettings.js'
import TutorProfile from '../models/TutorProfile.js'
import { logActivity } from '../utils/activityLogger.js'

const EDITABLE = ['url', 'label', 'platform', 'timing', 'note', 'theme', 'isActive', 'order']

function normalizeUrl(raw) {
  const url = String(raw || '').trim()
  if (!url) return ''
  // Tolerate a pasted "meet.google.com/abc-defg" — students tap it either way.
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

export async function listClassLinks(req, res) {
  try {
    const { search, status } = req.query
    const filter = {}
    if (status === 'active') filter.isActive = true
    if (status === 'inactive') filter.isActive = false
    if (search) {
      const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ tutorName: regex }, { label: regex }, { url: regex }]
    }

    const records = await ClassLink.find(filter)
      .populate('tutor', 'name tutorId status')
      .sort({ order: 1, tutorName: 1 })
      .lean()

    res.json({ records, total: records.length })
  } catch (err) {
    console.error('List class links error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function createClassLink(req, res) {
  try {
    const { tutorId, url } = req.body
    if (!tutorId || !url) return res.status(400).json({ error: 'Tutor and link are required' })

    const tutor = await TutorProfile.findById(tutorId).select('name').lean()
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' })

    // New links land at the end of the public grid.
    const last = await ClassLink.findOne().sort({ order: -1 }).select('order').lean()

    const link = await ClassLink.create({
      tutor: tutorId,
      tutorName: tutor.name,
      url: normalizeUrl(url),
      label: req.body.label || '',
      platform: req.body.platform || 'other',
      timing: req.body.timing || '',
      note: req.body.note || '',
      theme: req.body.theme === '' || req.body.theme == null ? null : Number(req.body.theme),
      isActive: req.body.isActive !== false,
      order: (last?.order ?? -1) + 1,
      createdBy: req.userId,
    })

    await logActivity({
      level: 'info', category: 'portal', action: 'class_link_created',
      message: `Class link published for ${tutor.name}`, req,
    })

    const populated = await ClassLink.findById(link._id).populate('tutor', 'name tutorId status').lean()
    res.status(201).json(populated)
  } catch (err) {
    console.error('Create class link error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateClassLink(req, res) {
  try {
    const link = await ClassLink.findById(req.params.id)
    if (!link) return res.status(404).json({ error: 'Class link not found' })

    // Reassigning the link to another tutor re-snapshots the name.
    if (req.body.tutorId && String(req.body.tutorId) !== String(link.tutor)) {
      const tutor = await TutorProfile.findById(req.body.tutorId).select('name').lean()
      if (!tutor) return res.status(404).json({ error: 'Tutor not found' })
      link.tutor = req.body.tutorId
      link.tutorName = tutor.name
    }

    for (const field of EDITABLE) {
      if (req.body[field] === undefined) continue
      if (field === 'url') link.url = normalizeUrl(req.body.url)
      else if (field === 'theme') link.theme = req.body.theme === '' || req.body.theme == null ? null : Number(req.body.theme)
      else link[field] = req.body[field]
    }
    if (!link.url) return res.status(400).json({ error: 'Link is required' })

    await link.save()
    const populated = await ClassLink.findById(link._id).populate('tutor', 'name tutorId status').lean()
    res.json(populated)
  } catch (err) {
    console.error('Update class link error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function deleteClassLink(req, res) {
  try {
    const link = await ClassLink.findByIdAndDelete(req.params.id)
    if (!link) return res.status(404).json({ error: 'Class link not found' })

    await logActivity({
      level: 'warning', category: 'portal', action: 'class_link_deleted',
      message: `Class link removed for ${link.tutorName}`, req,
    })
    res.json({ message: 'Class link deleted' })
  } catch (err) {
    console.error('Delete class link error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// Accepts the full ordered list of ids as shown in the manage table.
export async function reorderClassLinks(req, res) {
  try {
    const { ids } = req.body
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' })

    await ClassLink.bulkWrite(ids.map((id, i) => ({
      updateOne: { filter: { _id: id }, update: { $set: { order: i } } },
    })))
    res.json({ message: 'Order updated' })
  } catch (err) {
    console.error('Reorder class links error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function getClassLinkSettings(req, res) {
  try {
    const settings = await ClassLinkSettings.getSettings()
    res.json(settings)
  } catch (err) {
    console.error('Get class link settings error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateClassLinkSettings(req, res) {
  try {
    const settings = await ClassLinkSettings.getSettings()
    for (const field of ['headline', 'subheadline', 'accessCode', 'isPublished']) {
      if (req.body[field] !== undefined) settings[field] = req.body[field]
    }
    settings.updatedBy = req.userId
    await settings.save()

    await logActivity({
      level: 'info', category: 'portal', action: 'class_link_settings_updated',
      message: `Public class links page ${settings.isPublished ? 'published' : 'unpublished'}`, req,
    })
    res.json(settings)
  } catch (err) {
    console.error('Update class link settings error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

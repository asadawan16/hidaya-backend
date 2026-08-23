import Family from '../models/Family.js'
import Student from '../models/Student.js'
import StudentRelationship from '../models/StudentRelationship.js'
import { logActivity } from '../utils/activityLogger.js'

// Generate next family code: HF001, HF002, ...
// Families created before the rename still carry FAM### codes, so the counter
// walks BOTH prefixes and continues past the highest number seen — no two
// families ever share a number, whichever prefix they were created under.
async function generateFamilyCode() {
  const existing = await Family.find({ familyCode: { $regex: /^(HF|FAM)\d+$/ } })
    .select('familyCode')
    .lean()

  const highest = existing.reduce((max, f) => {
    const n = parseInt(String(f.familyCode).replace(/^(HF|FAM)/, ''), 10)
    return Number.isFinite(n) && n > max ? n : max
  }, 0)

  return `HF${String(highest + 1).padStart(3, '0')}`
}

// ─── Check family code availability ───
export async function checkFamilyCode(req, res) {
  try {
    const raw = (req.query.familyCode || '').trim().toUpperCase()
    const { excludeId } = req.query
    if (!raw) {
      return res.json({ available: false, suggestion: await generateFamilyCode() })
    }
    const filter = { familyCode: raw }
    if (excludeId) filter._id = { $ne: excludeId }
    const existing = await Family.findOne(filter).select('_id').lean()
    res.json({ available: !existing })
  } catch (err) {
    console.error('Check family code error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── List families ───
export async function listFamilies(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { search } = req.query

    const filter = {}

    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [
        { familyCode: regex },
        { 'primaryGuardian.name': regex },
        { 'primaryGuardian.phone': regex },
        { 'primaryGuardian.email': regex },
      ]
    }

    const total = await Family.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const records = await Family.find(filter)
      .populate('members', 'name rollNo status courseLabels')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    res.json({ records, total, page: safePage, pages })
  } catch (err) {
    console.error('List families error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Get single family ───
export async function getFamily(req, res) {
  try {
    const family = await Family.findById(req.params.id)
      .populate('members', 'name rollNo status courseLabels country guardians whatsappNumber billing createdAt dob timezone placementLevel sect')
      .lean()

    if (!family) return res.status(404).json({ error: 'Family not found' })

    // Fetch inter-student relationships for family members
    const memberIds = family.members.map(m => m._id)
    const relationships = memberIds.length > 0
      ? await StudentRelationship.find({
          $or: [
            { studentA: { $in: memberIds } },
            { studentB: { $in: memberIds } },
          ],
        }).populate('studentA', 'name').populate('studentB', 'name').lean()
      : []

    family.relationships = relationships

    res.json(family)
  } catch (err) {
    console.error('Get family error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Create family ───
export async function createFamily(req, res) {
  try {
    const { primaryGuardian, notes, memberIds } = req.body

    // Use the manually-entered code if provided, else auto-generate
    const familyCode = (req.body.familyCode || '').trim().toUpperCase() || await generateFamilyCode()

    const existing = await Family.findOne({ familyCode }).select('_id').lean()
    if (existing) {
      return res.status(409).json({ error: `Family code "${familyCode}" is already taken` })
    }

    const family = await Family.create({
      familyCode,
      primaryGuardian: primaryGuardian || {},
      members: memberIds || [],
      notes: notes || '',
    })

    // Set familyId on all member students
    if (memberIds?.length) {
      await Student.updateMany(
        { _id: { $in: memberIds } },
        { familyId: family._id },
      )
    }

    await logActivity({
      level: 'info',
      category: 'family_management',
      action: 'family_created',
      message: `Family created: ${familyCode}`,
      req,
      meta: { familyId: family._id },
    })

    // Return populated
    const populated = await Family.findById(family._id)
      .populate('members', 'name rollNo status courseLabels')
      .lean()

    res.status(201).json(populated)
  } catch (err) {
    console.error('Create family error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Update family ───
export async function updateFamily(req, res) {
  try {
    const family = await Family.findById(req.params.id)
    if (!family) return res.status(404).json({ error: 'Family not found' })

    const { primaryGuardian, notes, memberIds } = req.body

    // Allow renaming the family code, guarding uniqueness
    const newCode = (req.body.familyCode || '').trim().toUpperCase()
    if (newCode && newCode !== family.familyCode) {
      const clash = await Family.findOne({ familyCode: newCode, _id: { $ne: family._id } }).select('_id').lean()
      if (clash) {
        return res.status(409).json({ error: `Family code "${newCode}" is already taken` })
      }
      family.familyCode = newCode
    }

    if (primaryGuardian !== undefined) family.primaryGuardian = primaryGuardian
    if (notes !== undefined) family.notes = notes

    // Handle member changes
    if (memberIds !== undefined) {
      const oldMemberIds = family.members.map(m => m.toString())
      const newMemberIds = memberIds.map(String)

      // Remove familyId from students no longer in this family
      const removed = oldMemberIds.filter(id => !newMemberIds.includes(id))
      if (removed.length) {
        await Student.updateMany(
          { _id: { $in: removed }, familyId: family._id },
          { $unset: { familyId: 1 } },
        )
      }

      // Set familyId on new members
      const added = newMemberIds.filter(id => !oldMemberIds.includes(id))
      if (added.length) {
        await Student.updateMany(
          { _id: { $in: added } },
          { familyId: family._id },
        )
      }

      family.members = memberIds
    }

    await family.save()

    await logActivity({
      level: 'info',
      category: 'family_management',
      action: 'family_updated',
      message: `Family updated: ${family.familyCode}`,
      req,
      meta: { familyId: family._id },
    })

    const populated = await Family.findById(family._id)
      .populate('members', 'name rollNo status courseLabels')
      .lean()

    res.json(populated)
  } catch (err) {
    console.error('Update family error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Delete family ───
export async function deleteFamily(req, res) {
  try {
    const family = await Family.findById(req.params.id)
    if (!family) return res.status(404).json({ error: 'Family not found' })

    // Unset familyId from all member students
    await Student.updateMany(
      { familyId: family._id },
      { $unset: { familyId: 1 } },
    )

    await Family.findByIdAndDelete(req.params.id)

    await logActivity({
      level: 'warning',
      category: 'family_management',
      action: 'family_deleted',
      message: `Family deleted: ${family.familyCode}`,
      req,
      meta: { familyId: family._id },
    })

    res.json({ message: 'Family deleted' })
  } catch (err) {
    console.error('Delete family error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Family stats ───
export async function getFamilyStats(req, res) {
  try {
    const [total, withMembers] = await Promise.all([
      Family.countDocuments(),
      Family.countDocuments({ 'members.0': { $exists: true } }),
    ])

    const memberStats = await Family.aggregate([
      { $project: { memberCount: { $size: '$members' } } },
      { $group: { _id: null, totalMembers: { $sum: '$memberCount' }, avgMembers: { $avg: '$memberCount' } } },
    ])

    res.json({
      total,
      withMembers,
      empty: total - withMembers,
      totalMembers: memberStats[0]?.totalMembers || 0,
      avgMembers: Math.round((memberStats[0]?.avgMembers || 0) * 10) / 10,
    })
  } catch (err) {
    console.error('Family stats error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// ─── Search families (for dropdowns) ───
export async function searchFamilies(req, res) {
  try {
    const { q } = req.query
    const filter = {}

    if (q) {
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [
        { familyCode: regex },
        { 'primaryGuardian.name': regex },
      ]
    }

    const families = await Family.find(filter)
      .populate('members', 'name rollNo')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean()

    res.json(families)
  } catch (err) {
    console.error('Search families error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

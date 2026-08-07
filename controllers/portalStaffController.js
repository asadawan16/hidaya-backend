import User from '../models/User.js'
import Role from '../models/Role.js'
import StaffProfile from '../models/StaffProfile.js'
import StaffSalaryIncrement from '../models/StaffSalaryIncrement.js'
import TutorProfile from '../models/TutorProfile.js'
import { logActivity } from '../utils/activityLogger.js'
import { createNotification } from './portalNotificationController.js'

const CURRENCIES = ['PKR', 'USD', 'EUR', 'GBP', 'CAD']

// Base Mongo filter for "staff" = management/support portal users: not a student
// or tutor (by role OR profile link), and never the super_admin (the boss isn't a
// payroll subject). Mirrors getStaffSubjects in the finance controller, but here
// we keep ALL statuses so HR can configure suspended/pending staff too.
async function buildStaffFilter(extra = {}) {
  const roles = await Role.find({ key: { $in: ['student', 'tutor', 'super_admin'] } }).select('_id').lean()
  const excludeRoleIds = roles.map(r => r._id)
  const tutorOwners = await TutorProfile.find({ userId: { $ne: null } }).select('userId').lean()
  const tutorOwnerIds = tutorOwners.map(t => t.userId).filter(Boolean)
  return {
    linkedStudentId: { $in: [null, undefined] },
    linkedTutorId: { $in: [null, undefined] },
    roles: { $nin: excludeRoleIds },
    _id: { $nin: tutorOwnerIds },
    ...extra,
  }
}

// GET /portal/staff — paginated staff list, each merged with its StaffProfile.
export async function listStaff(req, res) {
  try {
    const pg = Math.max(1, parseInt(req.query.page, 10) || 1)
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
    const { search, status } = req.query

    const extra = {}
    if (status) extra.status = status
    if (search) {
      const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      extra.$or = [{ displayName: regex }, { email: regex }, { phone: regex }]
    }
    const filter = await buildStaffFilter(extra)

    const total = await User.countDocuments(filter)
    const pages = Math.ceil(total / lim) || 1
    const safePage = Math.min(pg, pages)

    const users = await User.find(filter)
      .populate('roles', 'key name')
      .select('displayName email phone status roles createdAt')
      .sort({ displayName: 1 })
      .skip((safePage - 1) * lim)
      .limit(lim)
      .lean()

    const profiles = await StaffProfile.find({ userId: { $in: users.map(u => u._id) } }).lean()
    const profByUser = new Map(profiles.map(p => [String(p.userId), p]))

    const records = users.map(u => ({
      ...u,
      profile: profByUser.get(String(u._id)) || null,
    }))

    // Org-wide stats across all matching staff (not just this page). Reuses the
    // same `filter` so status counts + payroll base stay in sync with the list.
    const allStaff = await User.find(filter).select('_id status').lean()
    const allProfiles = await StaffProfile.find({ userId: { $in: allStaff.map(u => u._id) } }).select('baseSalary salaryCurrency').lean()
    const monthlyBaseByCurrency = {}
    for (const p of allProfiles) {
      const c = p.salaryCurrency || 'PKR'
      monthlyBaseByCurrency[c] = (monthlyBaseByCurrency[c] || 0) + (p.baseSalary || 0)
    }
    const stats = {
      total,
      active: allStaff.filter(u => u.status === 'active').length,
      suspended: allStaff.filter(u => u.status === 'suspended').length,
      monthlyBaseByCurrency,
    }

    res.json({ records, total, page: safePage, pages, stats })
  } catch (err) {
    console.error('List staff error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// GET /portal/staff/:userId — one staff member: user + profile + increment history.
export async function getStaff(req, res) {
  try {
    const { userId } = req.params
    const user = await User.findById(userId)
      .populate('roles', 'key name')
      .select('displayName email phone status roles createdAt')
      .lean()
    if (!user) return res.status(404).json({ error: 'Staff member not found' })

    const [profile, increments] = await Promise.all([
      StaffProfile.findOne({ userId }).lean(),
      StaffSalaryIncrement.find({ userId }).populate('approvedBy', 'displayName').sort({ effectiveDate: -1 }).lean(),
    ])

    res.json({ user, profile: profile || null, increments })
  } catch (err) {
    console.error('Get staff error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// PATCH /portal/staff/:userId — upsert the HR profile (joining date, designation,
// department, base salary + currency, notes). Base salary here is the default the
// Salary tab picks up as "Monthly".
export async function updateStaffProfile(req, res) {
  try {
    const { userId } = req.params
    const user = await User.findById(userId).select('_id displayName').lean()
    if (!user) return res.status(404).json({ error: 'Staff member not found' })

    const set = {}
    if (req.body.title !== undefined) set.title = String(req.body.title).trim()
    if (req.body.department !== undefined) set.department = String(req.body.department).trim()
    if (req.body.notes !== undefined) set.notes = String(req.body.notes).trim()
    if (req.body.baseSalary !== undefined) set.baseSalary = Math.max(0, Number(req.body.baseSalary) || 0)
    if (req.body.salaryCurrency && CURRENCIES.includes(req.body.salaryCurrency)) set.salaryCurrency = req.body.salaryCurrency
    if (req.body.joiningDate !== undefined) {
      set.joiningDate = req.body.joiningDate ? new Date(req.body.joiningDate) : null
    }

    const profile = await StaffProfile.findOneAndUpdate(
      { userId },
      { $set: set, $setOnInsert: { userId } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean()

    await logActivity({ level: 'info', category: 'salary', action: 'staff_profile_updated', message: `Staff profile updated for ${user.displayName}`, req })
    res.json(profile)
  } catch (err) {
    console.error('Update staff profile error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// POST /portal/staff/:userId/increment — record a base-salary raise and bump the
// StaffProfile base (so future salary sheets default to the new amount).
export async function createStaffIncrement(req, res) {
  try {
    const { userId } = req.params
    const { newAmount, effectiveDate, reason } = req.body
    if (newAmount === undefined || !effectiveDate) {
      return res.status(400).json({ error: 'newAmount and effectiveDate are required' })
    }

    const user = await User.findById(userId).select('_id displayName').lean()
    if (!user) return res.status(404).json({ error: 'Staff member not found' })

    // Upsert the profile so an increment works even before a base was set.
    let profile = await StaffProfile.findOne({ userId })
    if (!profile) profile = await StaffProfile.create({ userId })

    const previousAmount = profile.baseSalary || 0
    const next = Math.max(0, Number(newAmount) || 0)
    const incrementAmount = next - previousAmount
    const incrementPercentage = previousAmount > 0
      ? Math.round((incrementAmount / previousAmount) * 10000) / 100
      : 0
    const currency = profile.salaryCurrency || 'PKR'

    const increment = await StaffSalaryIncrement.create({
      userId,
      previousAmount,
      newAmount: next,
      incrementAmount,
      incrementPercentage,
      currency,
      effectiveDate: new Date(effectiveDate),
      reason: reason || '',
      approvedBy: req.userId,
    })

    profile.baseSalary = next
    await profile.save()

    await logActivity({
      level: 'info', category: 'salary', action: 'staff_salary_increment',
      message: `Staff salary increment for ${user.displayName}: ${currency} ${previousAmount} → ${next} (${incrementPercentage > 0 ? '+' : ''}${incrementPercentage}%)`,
      req,
    })

    await createNotification({
      userId,
      type: 'salary_increment',
      title: 'Salary Increment',
      body: `Your base salary has been updated: ${currency} ${previousAmount.toLocaleString()} → ${next.toLocaleString()} (effective ${new Date(effectiveDate).toLocaleDateString()}).`,
      payload: { incrementId: increment._id },
    })

    const populated = await StaffSalaryIncrement.findById(increment._id).populate('approvedBy', 'displayName').lean()
    res.status(201).json(populated)
  } catch (err) {
    console.error('Create staff increment error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

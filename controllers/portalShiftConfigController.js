import ShiftConfig from '../models/ShiftConfig.js'

export async function getShiftConfig(req, res) {
  try {
    let config = await ShiftConfig.findOne({ key: 'default' }).lean()
    if (!config) {
      config = await ShiftConfig.create({ key: 'default' })
      config = config.toObject()
    }
    res.json(config)
  } catch (err) {
    console.error('Get shift config error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

export async function updateShiftConfig(req, res) {
  try {
    const { defaultShiftStart, defaultShiftEnd, overtimeThresholdMinutes, bonusRules } = req.body

    let config = await ShiftConfig.findOne({ key: 'default' })
    if (!config) config = new ShiftConfig({ key: 'default' })

    if (defaultShiftStart) config.defaultShiftStart = defaultShiftStart
    if (defaultShiftEnd) config.defaultShiftEnd = defaultShiftEnd
    if (overtimeThresholdMinutes !== undefined) config.overtimeThresholdMinutes = overtimeThresholdMinutes
    if (bonusRules) {
      config.bonusRules = { ...config.bonusRules?.toObject?.() || config.bonusRules || {}, ...bonusRules }
    }
    config.updatedBy = req.userId
    await config.save()

    res.json(config)
  } catch (err) {
    console.error('Update shift config error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

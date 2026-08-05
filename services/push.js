// Expo push notifications. Sends to the Expo push service, which fans out to
// APNs (iOS) and FCM (Android). No SDK dependency — a plain fetch to the HTTP
// API. Never throws: a push failure must not break the parent action.
//
// Expo push docs: https://docs.expo.dev/push-notifications/sending-notifications/
import User from '../models/User.js'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

function isExpoPushToken(token) {
  return typeof token === 'string' && /^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/.test(token)
}

/**
 * Send a push to every device registered for a user.
 * @param {string} userId
 * @param {{ title: string, body?: string, data?: object }} msg
 */
export async function sendPushToUser(userId, { title, body, data } = {}) {
  try {
    if (!userId || !title) return
    const user = await User.findById(userId).select('pushTokens').lean()
    const tokens = (user?.pushTokens || [])
      .map(t => t.token)
      .filter(isExpoPushToken)
    if (!tokens.length) return

    const messages = tokens.map(to => ({
      to,
      title,
      body: body || '',
      data: data || {},
      sound: 'default',
      channelId: 'default',
      priority: 'high',
    }))

    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    })

    // Prune tokens Expo reports as unregistered (DeviceNotRegistered).
    const json = await res.json().catch(() => null)
    const receipts = json?.data
    if (Array.isArray(receipts)) {
      const dead = []
      receipts.forEach((r, i) => {
        if (r?.status === 'error' && r?.details?.error === 'DeviceNotRegistered') {
          dead.push(tokens[i])
        }
      })
      if (dead.length) {
        await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token: { $in: dead } } } })
      }
    }
  } catch (err) {
    console.error('sendPushToUser failed:', err.message)
  }
}

export async function registerDevice(userId, { token, platform, deviceId }) {
  if (!isExpoPushToken(token)) throw new Error('Invalid push token')
  // upsert: remove any existing row with the same token (any user), then add.
  await User.updateMany({ 'pushTokens.token': token }, { $pull: { pushTokens: { token } } })
  await User.updateOne(
    { _id: userId },
    { $push: { pushTokens: { token, platform: platform === 'ios' ? 'ios' : 'android', deviceId: deviceId || '', lastSeenAt: new Date() } } },
  )
}

export async function unregisterDevice(userId, token) {
  await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token } } })
}

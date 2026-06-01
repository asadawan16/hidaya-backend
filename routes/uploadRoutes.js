import { Router } from 'express'
import { buildKey, presignPut, presignGet } from '../config/s3.js'
import auth from '../middleware/auth.js'

const router = Router()

// Admin — get presigned PUT URL for direct S3 upload
router.post('/presign', auth, async (req, res) => {
  try {
    const { filename, contentType, folder } = req.body || {}
    if (!filename || !contentType) {
      return res.status(400).json({ error: 'filename and contentType are required' })
    }
    const key = buildKey(filename, folder || 'blogs')
    const uploadUrl = await presignPut({ key, contentType })
    res.json({ uploadUrl, key })
  } catch (err) {
    console.error('Presign error:', err)
    res.status(500).json({ error: 'Failed to generate upload URL' })
  }
})

// Public — get short-lived GET URL for private objects
router.get('/sign-get', async (req, res) => {
  try {
    const { key } = req.query
    if (!key) return res.status(400).json({ error: 'key is required' })
    const url = await presignGet(key)
    res.json({ url })
  } catch (err) {
    console.error('Sign-get error:', err)
    res.status(500).json({ error: 'Failed to generate URL' })
  }
})

export default router

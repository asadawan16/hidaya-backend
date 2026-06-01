import { Router } from 'express'
import BlogPost from '../models/BlogPost.js'
import { presignGet, deleteObject } from '../config/s3.js'
import auth from '../middleware/auth.js'

const router = Router()

async function withCoverUrl(doc) {
  const obj = doc.toObject ? doc.toObject() : { ...doc }
  if (obj.coverImageKey) {
    try {
      obj.coverImageUrl = await presignGet(obj.coverImageKey)
    } catch {
      obj.coverImageUrl = ''
    }
  } else {
    obj.coverImageUrl = ''
  }
  return obj
}

// Public — list published
router.get('/', async (req, res) => {
  try {
    const posts = await BlogPost.find({ published: true }).sort({ publishedAt: -1 })
    const enriched = await Promise.all(posts.map(withCoverUrl))
    res.json(enriched)
  } catch (err) {
    console.error('Blog list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Public — get by slug
router.get('/slug/:slug', async (req, res) => {
  try {
    const post = await BlogPost.findOne({ slug: req.params.slug, published: true })
    if (!post) return res.status(404).json({ error: 'Not found' })
    res.json(await withCoverUrl(post))
  } catch (err) {
    console.error('Blog get error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Admin — list all (including drafts)
router.get('/admin/all', auth, async (req, res) => {
  try {
    const posts = await BlogPost.find().sort({ createdAt: -1 })
    const enriched = await Promise.all(posts.map(withCoverUrl))
    res.json(enriched)
  } catch (err) {
    console.error('Blog admin list error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Admin — create
router.post('/', auth, async (req, res) => {
  try {
    const post = await BlogPost.create(req.body)
    res.status(201).json(post)
  } catch (err) {
    console.error('Blog create error:', err)
    res.status(500).json({ error: err.message || 'Server error' })
  }
})

// Admin — update
router.patch('/:id', auth, async (req, res) => {
  try {
    const post = await BlogPost.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!post) return res.status(404).json({ error: 'Not found' })
    res.json(await withCoverUrl(post))
  } catch (err) {
    console.error('Blog update error:', err)
    res.status(500).json({ error: err.message || 'Server error' })
  }
})

// Admin — delete
router.delete('/:id', auth, async (req, res) => {
  try {
    const post = await BlogPost.findByIdAndDelete(req.params.id)
    if (!post) return res.status(404).json({ error: 'Not found' })
    if (post.coverImageKey) {
      deleteObject(post.coverImageKey).catch(() => {})
    }
    res.json({ message: 'Deleted' })
  } catch (err) {
    console.error('Blog delete error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router

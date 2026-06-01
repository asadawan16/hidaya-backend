import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import crypto from 'crypto'
import path from 'path'

const region = process.env.AWS_REGION
const Bucket = process.env.AWS_S3_BUCKET

if (!region || !Bucket) {
  console.warn('[s3] AWS_REGION or AWS_S3_BUCKET not set — uploads will fail')
}

export const s3 = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
})

const EXPIRES = Number(process.env.PRESIGN_EXPIRES || 900)

export function buildKey(originalFilename, folder = 'uploads') {
  const ext = path.extname(originalFilename || '').toLowerCase()
  const rand = crypto.randomBytes(8).toString('hex')
  const stamp = Date.now()
  return `${folder}/${stamp}-${rand}${ext}`
}

export async function presignPut({ key, contentType }) {
  const cmd = new PutObjectCommand({ Bucket, Key: key, ContentType: contentType })
  return getSignedUrl(s3, cmd, { expiresIn: EXPIRES })
}

export async function presignGet(key) {
  const cmd = new GetObjectCommand({ Bucket, Key: key })
  return getSignedUrl(s3, cmd, { expiresIn: EXPIRES })
}

export async function deleteObject(key) {
  if (!key) return
  await s3.send(new DeleteObjectCommand({ Bucket, Key: key }))
}

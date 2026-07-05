import { createRequire } from 'module'
import crypto from 'crypto'

const require = createRequire(import.meta.url)
const { generateSecret: otpGenSecret, generateURI, verifySync } = require('otplib')
const QRCode = require('qrcode')

const ALGORITHM = 'aes-256-gcm'
const ISSUER = 'Hidaya Online'

function getEncryptionKey() {
  const key = process.env.MFA_ENCRYPTION_KEY
  if (!key || key.length !== 64) {
    throw new Error('MFA_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)')
  }
  return Buffer.from(key, 'hex')
}

export function generateSecret(userEmail) {
  const secret = otpGenSecret()
  const otpauthUrl = generateURI({ issuer: ISSUER, label: userEmail, secret, type: 'totp' })
  return { secret, otpauthUrl }
}

export function encryptSecret(plainSecret) {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(plainSecret, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')
  return `${iv.toString('hex')}:${authTag}:${encrypted}`
}

export function decryptSecret(encryptedString) {
  const key = getEncryptionKey()
  const [ivHex, authTagHex, ciphertext] = encryptedString.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

export function verifyToken(encryptedSecret, token) {
  const secret = decryptSecret(encryptedSecret)
  return verifySync({ secret, token })
}

export async function generateQRDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl)
}

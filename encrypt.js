import crypto from 'crypto'
import 'dotenv/config'

const ALGORITHM = 'aes-256-cbc'
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'utf8')
const IV_LENGTH = 16

export function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv)
    const encrypted = Buffer.concat([cipher.update(text), cipher.final()])
    return iv.toString('hex') + ':' + encrypted.toString('hex')
}

export function decrypt(text) {
    try {
        const [ivHex, encryptedHex] = text.split(':')
        if (!encryptedHex) return text
        const iv = Buffer.from(ivHex, 'hex')
        const encrypted = Buffer.from(encryptedHex, 'hex')
        const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv)
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString()
    } catch {
        return text
    }
}
import mongoose from "mongoose";
import { encrypt, decrypt } from '../encrypt.js';

function encryptField(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return encrypt(value);
}

function decryptField(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return decrypt(value);
}

const messageSchema = new mongoose.Schema({
  topic: {
    type: String,
    required: true,
    index: true
  },

  peerId: {
    type: String,
    required: true
  },

  type: {
    type: String,
    enum: ['text', 'voice'],
    default: 'text',
    index: true
  },

  message: {
    type: String,
    default: '',
    set: encryptField,
    get: decryptField
  },

  audio: {
    type: String,
    default: '',
    set: encryptField,
    get: decryptField
  },

  mimeType: {
    type: String,
    default: ''
  },

  durationMs: {
    type: Number,
    default: 0
  },

  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Auto delete after 24 hours.
// Change 86400 to 3600 if you want 1 hour.
messageSchema.index({ timestamp: 1 }, { expireAfterSeconds: 86400 });

messageSchema.set('toJSON', { getters: true });
messageSchema.set('toObject', { getters: true });

const Message = mongoose.model('Message', messageSchema);

export { Message };
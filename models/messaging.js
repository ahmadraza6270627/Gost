import mongoose from "mongoose";
import { encrypt, decrypt } from '../encrypt.js'

const messageSchema = new mongoose.Schema({
  topic: String,
  peerId: String,
  message: {
    type: String,
    set: (value) => encrypt(value),
    get: (value) => decrypt(value)
  },
  timestamp: { type: Date, default: Date.now }
});

// ✅ Auto delete after 24 hours
messageSchema.index({ timestamp: 1 }, { expireAfterSeconds: 3600 })

messageSchema.set('toJSON', { getters: true });
messageSchema.set('toObject', { getters: true });

const Message = mongoose.model('Message', messageSchema);

export { Message }
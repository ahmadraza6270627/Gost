import mongoose from "mongoose";

const activeSessionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    sessionId: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

const ActiveSession = mongoose.model('ActiveSession', activeSessionSchema);

export { ActiveSession }
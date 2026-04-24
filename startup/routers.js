import { ActiveSession } from '../models/activeSession.js'
import { error } from '../middleware/error.js';
import { user } from "../routers/user.js";
import { auth } from "../routers/auth.js";
import { homepage } from '../routers/home_page.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { Message } from '../models/messaging.js';
import express from "express";
import cors from "cors";
import path from "path";
import session from "express-session";
import rateLimit from "express-rate-limit";

export function routers(app) {
    const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173'

    if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET is not set!')

    const authLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10,
        message: 'Too many login attempts, please try again later'
    })

    app.use(cors({
        origin: clientOrigin,
        credentials: true
    }));
    app.use(express.static(path.resolve("views")));
    app.set("view engine", "pug");
    app.use(express.json());

    app.use(session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 1000 * 60 * 60
        }
    }));

    app.use("/", homepage);
    app.use("/user", user);
    app.use("/auth", authLimiter, auth);
    app.use(error);

    app.get('/api/check-auth', (req, res) => {
        if (req.session && req.session.userId) {
            return res.status(200).json({ authenticated: true });
        }
        res.status(401).json({ authenticated: false });
    });

    app.get('/dashboard', requireAuth, (req, res) => {
        res.sendFile(path.resolve("./p2p.html"));
    });

    // ✅ Correct session check — uses sessionId from sessionStorage
    app.post('/api/check-session', async (req, res) => {
        try {
            const { sessionId } = req.body
            if (!sessionId) return res.json({ valid: false })
            const active = await ActiveSession.findOne({ sessionId })
            res.json({ valid: !!active })
        } catch {
            res.json({ valid: false })
        }
    })

    // ── Message persistence ──────────────────────────────────────────────────
    app.post('/messages', async (req, res) => {
        try {
            const { topic, peerId, message } = req.body;
            const msg = new Message({ topic, peerId, message });
            await msg.save();
            res.status(201).json(msg);
        } catch (e) {
            console.error('Failed to save message:', e.message);
            res.status(500).json({ error: 'Failed to save message' });
        }
    });

    app.get('/messages/:topic', async (req, res) => {
        try {
            const messages = await Message.find({ topic: req.params.topic });
            res.status(200).json(messages);
        } catch (e) {
            console.error('Failed to fetch messages:', e.message);
            res.status(500).json({ error: 'Failed to fetch messages' });
        }
    });
}
import http from 'http'
import { randomUUID } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'

const RELAY_HOST = process.env.RELAY_HOST || '0.0.0.0'
const PORT = Number(process.env.PORT || 8080)
const MAX_VOICE_BASE64_CHARS = 1_700_000

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)

const rooms = new Map()

function isOriginAllowed(origin = '') {
  return ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)
}

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(payload))
}

function getRoom(topic) {
  if (!rooms.has(topic)) rooms.set(topic, new Map())
  return rooms.get(topic)
}

function getMemberCount(topic) {
  const room = rooms.get(topic)
  return room ? room.size : 0
}

function broadcast(topic, payload, excludeWs = null) {
  const room = rooms.get(topic)
  if (!room) return

  for (const client of room.values()) {
    if (client.ws === excludeWs) continue
    sendJson(client.ws, payload)
  }
}

function leaveRoom(ws) {
  if (!ws.topic || !ws.clientId) return

  const topic = ws.topic
  const clientId = ws.clientId
  const room = rooms.get(topic)

  if (room) {
    room.delete(clientId)

    if (room.size === 0) {
      rooms.delete(topic)
    } else {
      broadcast(topic, {
        type: 'peer-left',
        topic,
        memberCount: getMemberCount(topic)
      })
    }
  }

  ws.topic = null
  ws.clientId = null
}

function joinRoom(ws, topic, clientId) {
  leaveRoom(ws)

  const room = getRoom(topic)
  const existing = room.get(clientId)

  if (existing && existing.ws !== ws) {
    try {
      existing.ws.close(4000, 'duplicate client')
    } catch {}
  }

  ws.topic = topic
  ws.clientId = clientId

  room.set(clientId, {
    ws,
    clientId,
    joinedAt: Date.now()
  })

  const memberCount = getMemberCount(topic)

  sendJson(ws, {
    type: 'joined',
    topic,
    memberCount
  })

  broadcast(topic, {
    type: 'peer-joined',
    topic,
    memberCount
  }, ws)

  console.log(`[join] topic="${topic}" roomSize=${room.size}`)
}

function handleClientMessage(ws, raw) {
  let msg

  try {
    msg = JSON.parse(raw.toString())
  } catch {
    sendJson(ws, { type: 'error', message: 'Invalid JSON' })
    return
  }

  if (msg.type === 'join') {
    const topic = String(msg.topic || '').trim()
    const clientId = String(msg.clientId || '').trim()

    if (!topic || !clientId) {
      sendJson(ws, { type: 'error', message: 'Missing topic or clientId' })
      return
    }

    joinRoom(ws, topic, clientId)
    return
  }

  if (msg.type === 'message') {
    if (!ws.topic || !ws.clientId) {
      sendJson(ws, { type: 'error', message: 'Join a topic before sending messages' })
      return
    }

    const text = String(msg.text || '').trim()
    if (!text) return

    broadcast(ws.topic, {
      type: 'message',
      topic: ws.topic,
      messageId: msg.messageId || randomUUID(),
      text,
      createdAt: Date.now()
    }, ws)

    return
  }

  if (msg.type === 'voice') {
    if (!ws.topic || !ws.clientId) {
      sendJson(ws, { type: 'error', message: 'Join a topic before sending voice notes' })
      return
    }

    const audio = String(msg.audio || '')
    const mimeType = String(msg.mimeType || 'audio/webm')
    const durationMs = Number(msg.durationMs || 0)

    if (!audio || !mimeType.startsWith('audio/')) {
      sendJson(ws, { type: 'error', message: 'Missing voice payload' })
      return
    }

    if (audio.length > MAX_VOICE_BASE64_CHARS) {
      sendJson(ws, { type: 'error', message: 'Voice note is too large' })
      return
    }

    broadcast(ws.topic, {
      type: 'voice',
      topic: ws.topic,
      messageId: msg.messageId || randomUUID(),
      audio,
      mimeType,
      durationMs,
      createdAt: Date.now()
    }, ws)

    return
  }

  if (msg.type === 'ping') {
    sendJson(ws, { type: 'pong', time: Date.now() })
    return
  }

  sendJson(ws, { type: 'error', message: 'Unknown message type' })
}

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      mode: 'websocket-hub',
      rooms: rooms.size,
      voiceNotes: true
    }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/rooms') {
    const data = [...rooms.entries()].map(([topic, clients]) => ({
      topic,
      count: clients.size
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ rooms: data }))
    return
  }

  res.writeHead(404)
  res.end('not found')
})

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 2 * 1024 * 1024,
  verifyClient: ({ origin }, done) => {
    if (isOriginAllowed(origin)) return done(true)
    done(false, 403, 'Forbidden origin')
  }
})

wss.on('connection', (ws, req) => {
  ws.isAlive = true

  ws.on('pong', () => {
    ws.isAlive = true
  })

  ws.on('message', raw => handleClientMessage(ws, raw))
  ws.on('close', () => leaveRoom(ws))
  ws.on('error', () => leaveRoom(ws))

  console.log(`[ws] connected from ${req.socket.remoteAddress}`)
})

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      leaveRoom(ws)
      ws.terminate()
      continue
    }

    ws.isAlive = false
    ws.ping()
  }
}, 30_000)

httpServer.listen(PORT, RELAY_HOST, () => {
  console.log(`WebSocket hub relay listening on ${RELAY_HOST}:${PORT}`)
})
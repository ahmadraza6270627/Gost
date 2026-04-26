import http from 'http'
import { randomUUID } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'

const RELAY_HOST = process.env.RELAY_HOST || '0.0.0.0'
const PORT = Number(process.env.PORT || 8080)

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

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set())
  return rooms.get(roomId)
}

function leaveRoom(ws) {
  if (!ws.roomId) return

  const room = rooms.get(ws.roomId)

  if (room) {
    room.delete(ws)
    if (room.size === 0) rooms.delete(ws.roomId)
  }

  ws.roomId = null
}

function joinRoom(ws, roomId) {
  leaveRoom(ws)

  ws.roomId = roomId
  getRoom(roomId).add(ws)

  sendJson(ws, {
    type: 'joined'
  })

  console.log(`[join] encrypted-room=${roomId.slice(0, 12)}...`)
}

function broadcast(roomId, payload, sender) {
  const room = rooms.get(roomId)
  if (!room) return

  for (const client of room) {
    if (client === sender) continue
    sendJson(client, payload)
  }
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
    const roomId = String(msg.roomId || '').trim()

    if (!roomId) {
      sendJson(ws, { type: 'error', message: 'Missing roomId' })
      return
    }

    joinRoom(ws, roomId)
    return
  }

  if (msg.type === 'message') {
    if (!ws.roomId) {
      sendJson(ws, { type: 'error', message: 'Join a room before sending messages' })
      return
    }

    if (!msg.payload || typeof msg.payload !== 'object') {
      sendJson(ws, { type: 'error', message: 'Missing encrypted payload' })
      return
    }

    broadcast(ws.roomId, {
      type: 'message',
      messageId: msg.messageId || randomUUID(),
      payload: msg.payload,
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
      mode: 'encrypted-websocket-hub',
      rooms: rooms.size
    }))
    return
  }

  res.writeHead(404)
  res.end('not found')
})

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 128 * 1024,
  verifyClient: ({ origin }, done) => {
    if (isOriginAllowed(origin)) return done(true)
    done(false, 403, 'Forbidden origin')
  }
})

wss.on('connection', (ws, req) => {
  ws.isAlive = true
  ws.roomId = null

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
  console.log(`Encrypted WebSocket hub relay listening on ${RELAY_HOST}:${PORT}`)
})
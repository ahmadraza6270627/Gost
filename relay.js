import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { mplex } from '@libp2p/mplex'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { createLibp2p } from 'libp2p'
import http from 'http'

const RELAY_HOST      = process.env.RELAY_HOST              || '0.0.0.0'
const PORT            = process.env.PORT                    || 8080
const PUBLIC_DOMAIN   = process.env.RAILWAY_PUBLIC_DOMAIN   || 'localhost'

// ── Single HTTP server shared by libp2p WS + REST API ─────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/relay') {
    const multiaddrs = server.getMultiaddrs().map(ma => ma.toString())
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ multiaddrs }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/peers') {
    const topic   = url.searchParams.get('topic')
    const exclude = url.searchParams.get('exclude')
    if (!topic) { res.writeHead(400); res.end('missing topic'); return }
    const peers = (topicPeers[topic] || []).filter(p => p.peerId !== exclude)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ peers }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/peers') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        const { topic, peerId, multiaddrs } = JSON.parse(body)
        if (!topic || !peerId || !multiaddrs) { res.writeHead(400); res.end('bad body'); return }
        if (!topicPeers[topic]) topicPeers[topic] = []
        const existing = topicPeers[topic].find(p => p.peerId === peerId)
        if (existing) { existing.multiaddrs = multiaddrs }
        else { topicPeers[topic].push({ peerId, multiaddrs }) }
        console.log(`[registry] topic="${topic}" peer=${peerId}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch { res.writeHead(400); res.end('invalid json') }
    })
    return
  }

  res.writeHead(404); res.end('not found')
})

const topicPeers = {}

// Start HTTP server first, then pass it to libp2p
httpServer.listen(PORT, RELAY_HOST, async () => {
  console.log(`HTTP API → port ${PORT}`)
})

// ── libp2p relay — shares the same HTTP server for WebSocket upgrade ──────────
const server = await createLibp2p({
  addresses: {
    listen:   [`/ip4/${RELAY_HOST}/tcp/${PORT}/ws`],
    announce: [`/dns4/${PUBLIC_DOMAIN}/tcp/443/wss`]
  },
  transports: [webSockets({
    filter: filters.all,
    server: httpServer   // ← share the HTTP server
  })],
  connectionEncryption: [noise()],
  streamMuxers:         [yamux(), mplex()],
  services: {
    identify: identify(),
    relay:    circuitRelayServer({ reservations: { maxReservations: Infinity } })
  },
  connectionManager: { minConnections: 0 }
})

await server.start()

const relayMultiaddrs = server.getMultiaddrs().map(ma => ma.toString())
console.log('Relay listening on:', relayMultiaddrs)

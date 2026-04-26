import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { mplex } from '@libp2p/mplex'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { createLibp2p } from 'libp2p'
import http from 'http'

const RELAY_HOST    = process.env.RELAY_HOST || '0.0.0.0'
const PORT          = process.env.PORT || 8080
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost'
const PEER_TTL_MS   = Number(process.env.PEER_TTL_MS || 30000)

const topicPeers = {}

function getFreshPeers(topic) {
  const cutoff = Date.now() - PEER_TTL_MS
  topicPeers[topic] = (topicPeers[topic] || []).filter(peer => peer.lastSeen > cutoff)

  if (topicPeers[topic].length === 0) {
    delete topicPeers[topic]
    return []
  }

  return topicPeers[topic]
}

function pruneAllTopics() {
  for (const topic of Object.keys(topicPeers)) {
    getFreshPeers(topic)
  }
}

setInterval(pruneAllTopics, 10000).unref?.()

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/relay') {
    const multiaddrs = server.getMultiaddrs().map(ma => ma.toString())
    sendJson(res, 200, { multiaddrs })
    return
  }

  if (req.method === 'GET' && url.pathname === '/peers') {
    const topic = url.searchParams.get('topic')
    const exclude = url.searchParams.get('exclude')

    if (!topic) {
      res.writeHead(400)
      res.end('missing topic')
      return
    }

    const peers = getFreshPeers(topic)
      .filter(peer => peer.peerId !== exclude)
      .map(({ peerId, multiaddrs, lastSeen }) => ({
        peerId,
        multiaddrs,
        lastSeen
      }))

    sendJson(res, 200, { peers })
    return
  }

  if (req.method === 'POST' && url.pathname === '/peers') {
    let body = ''

    req.on('data', chunk => {
      body += chunk
    })

    req.on('end', () => {
      try {
        const { topic, peerId, multiaddrs } = JSON.parse(body)

        if (!topic || !peerId || !Array.isArray(multiaddrs)) {
          res.writeHead(400)
          res.end('bad body')
          return
        }

        const circuitAddrs = multiaddrs.filter(addr =>
          typeof addr === 'string' && addr.includes('/p2p-circuit')
        )

        if (circuitAddrs.length === 0) {
          res.writeHead(400)
          res.end('peer has no /p2p-circuit address yet')
          return
        }

        getFreshPeers(topic)

        if (!topicPeers[topic]) topicPeers[topic] = []

        const existing = topicPeers[topic].find(peer => peer.peerId === peerId)

        if (existing) {
          existing.multiaddrs = circuitAddrs
          existing.lastSeen = Date.now()
        } else {
          topicPeers[topic].push({
            peerId,
            multiaddrs: circuitAddrs,
            lastSeen: Date.now()
          })
        }

        console.log(`[registry] topic="${topic}" peer=${peerId} addrs=${circuitAddrs.length}`)
        sendJson(res, 200, { ok: true })
      } catch {
        res.writeHead(400)
        res.end('invalid json')
      }
    })

    return
  }

  if (req.method === 'DELETE' && url.pathname === '/peers') {
    const topic = url.searchParams.get('topic')
    const peerId = url.searchParams.get('peerId')

    if (!topic || !peerId) {
      res.writeHead(400)
      res.end('missing topic or peerId')
      return
    }

    topicPeers[topic] = (topicPeers[topic] || []).filter(peer => peer.peerId !== peerId)

    if (topicPeers[topic].length === 0) {
      delete topicPeers[topic]
    }

    console.log(`[registry:delete] topic="${topic}" peer=${peerId}`)
    sendJson(res, 200, { ok: true })
    return
  }

  res.writeHead(404)
  res.end('not found')
})

httpServer.listen(PORT, RELAY_HOST, async () => {
  console.log(`HTTP API → port ${PORT}`)
})

const server = await createLibp2p({
  addresses: {
    listen: [`/ip4/${RELAY_HOST}/tcp/${PORT}/ws`],
    announce: [`/dns4/${PUBLIC_DOMAIN}/tcp/443/wss`]
  },
  transports: [
    webSockets({
      filter: filters.all,
      server: httpServer
    })
  ],
  connectionEncryption: [noise()],
  streamMuxers: [yamux(), mplex()],
  services: {
    identify: identify(),
    relay: circuitRelayServer({
      reservations: {
        maxReservations: Infinity
      }
    })
  },
  connectionManager: {
    minConnections: 0
  }
})

await server.start()

const relayMultiaddrs = server.getMultiaddrs().map(ma => ma.toString())
console.log('Relay listening on:', relayMultiaddrs)
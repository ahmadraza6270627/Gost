import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { mplex } from '@libp2p/mplex'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { createLibp2p } from 'libp2p'
import http from 'http'

const RELAY_HOST = process.env.RELAY_HOST || '0.0.0.0'

const server = await createLibp2p({
  addresses: {
    listen: [`/ip4/${RELAY_HOST}/tcp/0/ws`]
  },
  transports: [webSockets({ filter: filters.all })],
  connectionEncryption: [noise()],
  streamMuxers: [yamux(), mplex()],
  services: {
    identify: identify(),
    relay: circuitRelayServer({ reservations: { maxReservations: Infinity } })
  },
  connectionManager: { minConnections: 0 }
})

const relayMultiaddrs = server.getMultiaddrs().map(ma => ma.toString())
console.log('Relay listening on:', relayMultiaddrs)

const topicPeers = {}
const RELAY_HTTP_PORT = process.env.RELAY_HTTP_PORT || 4001
const CLIENT_ORIGIN   = process.env.CLIENT_ORIGIN   || 'http://localhost:5173'

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CLIENT_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://localhost:${RELAY_HTTP_PORT}`)

  if (req.method === 'GET' && url.pathname === '/relay') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ multiaddrs: relayMultiaddrs }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/peers') {
    const topic = url.searchParams.get('topic')
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

httpServer.listen(RELAY_HTTP_PORT, () => {
  console.log(`Relay HTTP API → port ${RELAY_HTTP_PORT}`)
})

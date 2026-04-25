import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { dcutr } from '@libp2p/dcutr'
import { identify } from '@libp2p/identify'
import { webRTC } from '@libp2p/webrtc'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'
import { fromString, toString } from 'uint8arrays'

// ── Auth guard ────────────────────────────────────────────────────────────────
if (!sessionStorage.getItem('authToken')) {
  window.location.href = '/index.html'
  throw new Error('Unauthorized')
}

const RELAY_API    = import.meta.env.VITE_RELAY_URL || 'http://localhost:4001'
const MESSAGES_API = import.meta.env.VITE_API_URL   || 'http://localhost:5000'

// ── DOM helpers ────────────────────────────────────────────────────────────────
const DOM = {
  peerId:          () => document.getElementById('peer-id'),
  topicInput:      () => document.getElementById('topic-input'),
  subscribeButton: () => document.getElementById('subscribe-button'),
  messageInput:    () => document.getElementById('message-input'),
  sendButton:      () => document.getElementById('send-button'),
  output:          () => document.getElementById('output'),
  statusDot:       () => document.getElementById('status-dot'),
  statusText:      () => document.getElementById('status-text'),
  topicPeerList:   () => document.getElementById('topic-peers'),
  currentTopic:    () => document.getElementById('current-topic'),
}

// ── Clean log ─────────────────────────────────────────────────────────────────
const log = (line, type = 'info') => {
  if (window.addLog) {
    window.addLog(line, type)
  } else {
    const el = document.createElement('div')
    el.className = `log-line log-${type}`
    el.textContent = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} › ${line}`
    DOM.output().appendChild(el)
    DOM.output().scrollTop = DOM.output().scrollHeight
  }
}

const setStatus = (state, text) => {
  if (window.setStatus) {
    window.setStatus(text, state)
  } else {
    DOM.statusDot().className = `s-dot dot-${state}`
    DOM.statusText().textContent = text
  }
}

// ── libp2p node ────────────────────────────────────────────────────────────────
const libp2p = await createLibp2p({
  addresses: { listen: ['/webrtc'] },
  transports: [
    webSockets({ filter: filters.all }),
    webRTC(),
    circuitRelayTransport({ discoverRelays: 1 })
  ],
  connectionEncryption: [noise()],
  streamMuxers: [yamux()],
  connectionGater: { denyDialMultiaddr: () => false },
  services: {
    identify: identify(),
    pubsub: gossipsub({
      allowPublishToZeroPeers: true,
      D: 2,
      Dlo: 1,
      Dhi: 4,
      floodPublish: true,
      heartbeatInterval: 700,
      emitSelf: false
    }),
    dcutr: dcutr()
  },
  connectionManager: { minConnections: 0 }
})

// Set peer ID in header chip
if (window.setPeerId) {
  window.setPeerId(libp2p.peerId.toString())
} else {
  DOM.peerId().textContent = libp2p.peerId.toString()
}

// ── Expose debug helpers to browser console ───────────────────────────────────
// After clicking Connect, run window.debug() in DevTools to see full state
window._libp2p = libp2p
window.debug = () => {
  const topic = currentTopic
  console.group('P2P Debug Info')
  console.log('Topic:', topic)
  console.log('My Peer ID:', libp2p.peerId.toString())
  console.log('Connected peers:', libp2p.getPeers().map(p => p.toString()))
  console.log('My multiaddrs:', libp2p.getMultiaddrs().map(a => a.toString()))
  if (topic) {
    console.log('Pubsub subscribers:', libp2p.services.pubsub.getSubscribers(topic).map(p => p.toString()))
  } else {
    console.log('Pubsub subscribers: (no topic yet)')
  }
  console.groupEnd()
}

// ── Peer joined/left notifications ────────────────────────────────────────────
libp2p.addEventListener('connection:open', () => {
  if (currentTopic) {
    setStatus('connected', `Connected — topic: ${currentTopic}`)
  }
})

libp2p.addEventListener('connection:close', () => {
  if (currentTopic) {
    const count = libp2p.getPeers().length
    if (count === 0) {
      setStatus('waiting', 'Waiting for peers…')
      log('A peer disconnected. Waiting for others…', 'info')
    }
  }
})

// ── Subscribe flow ─────────────────────────────────────────────────────────────
let currentTopic = null

DOM.subscribeButton().onclick = async () => {
  const topic = DOM.topicInput().value.trim()
  if (!topic) return

  DOM.subscribeButton().disabled = true
  DOM.topicInput().disabled = true
  currentTopic = topic
  DOM.currentTopic().textContent = topic

  setStatus('connecting', 'Connecting…')

  try {
    // Fetch relay addresses
    const relayRes = await fetch(`${RELAY_API}/relay`)
    const { multiaddrs: relayAddrs } = await relayRes.json()
    if (!relayAddrs || relayAddrs.length === 0) throw new Error('Relay unavailable')

    // Try all relay addresses until one works
    let connected = false
    for (const addr of relayAddrs) {
      try {
        await libp2p.dial(multiaddr(addr))
        connected = true
        break
      } catch { /* try next */ }
    }
    if (!connected) throw new Error('Could not connect to relay')

    setStatus('relay', 'Setting up secure connection…')

    // Wait for WebRTC/circuit address
    await waitForWebRTCAddress()

    // ── FIX: Subscribe to gossipsub BEFORE dialing peers ──────────────────────
    // GossipSub includes your current subscriptions in the HELLO handshake
    // when a new connection is established. If you subscribe AFTER dialing,
    // the other peer's gossipsub won't know you're subscribed during that
    // handshake, so your subscription message might arrive too late and
    // messages sent shortly after connecting will be missed.
    libp2p.services.pubsub.subscribe(topic)
    log(`Subscribed to channel "${topic}"`, 'info')

    // Register in peer registry
    const myAddrs = libp2p.getMultiaddrs().map(ma => ma.toString())
    await fetch(`${RELAY_API}/peers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, peerId: libp2p.peerId.toString(), multiaddrs: myAddrs })
    })

    // Find and connect to existing peers
    const peersRes = await fetch(
      `${RELAY_API}/peers?topic=${encodeURIComponent(topic)}&exclude=${libp2p.peerId.toString()}`
    )
    const { peers } = await peersRes.json()

    if (peers.length === 0) {
      setStatus('waiting', 'Waiting for others to join…')
      log('You are the first one here. Share the topic name to invite others.', 'info')
      DOM.messageInput().disabled = false
      DOM.sendButton().disabled = false
    } else {
      log(`Found ${peers.length} peer(s), connecting…`, 'info')

      for (const peer of peers) {
        const addrs = [
          ...peer.multiaddrs.filter(a => a.includes('/webrtc') || a.includes('/p2p-circuit')),
          ...peer.multiaddrs.filter(a => !a.includes('/webrtc') && !a.includes('/p2p-circuit'))
        ]
        for (const addr of addrs) {
          try { await libp2p.dial(multiaddr(addr)); break } catch { /* silent */ }
        }
      }

      setStatus('connected', `Connected — topic: ${topic}`)
      log(`Connected to channel "${topic}" ✓`, 'success')

      // ── FIX: Wait for gossipsub mesh to confirm the peer ──────────────────
      // Even with floodPublish, gossipsub needs one heartbeat (~700ms) to
      // confirm peers are subscribed. We wait up to 4s before enabling send.
      await waitForGossipsubPeer(topic)

      DOM.messageInput().disabled = false
      DOM.sendButton().disabled = false
    }

    // Load message history
    try {
      const historyRes = await fetch(`${MESSAGES_API}/messages/${encodeURIComponent(topic)}`)
      const history = await historyRes.json()
      if (history.length > 0) {
        log(`── ${history.length} previous message(s) ──`, 'info')
        for (const m of history) {
          const sender = m.peerId === libp2p.peerId.toString() ? 'You' : 'Peer'
          log(`${sender}: ${m.message}`, m.peerId === libp2p.peerId.toString() ? 'sent' : 'received')
        }
      }
    } catch { /* history optional */ }

  } catch (err) {
    setStatus('error', 'Connection failed — try again')
    log(`Connection error: ${err.message}`, 'error')
    DOM.subscribeButton().disabled = false
    DOM.topicInput().disabled = false
    currentTopic = null
  }
}

// ── Helper: wait for WebRTC/circuit address ────────────────────────────────────
function waitForWebRTCAddress(timeout = 15000) {
  return new Promise((resolve) => {
    const check = () => {
      const addrs = libp2p.getMultiaddrs().map(ma => ma.toString())
      if (addrs.some(a => a.includes('/webrtc') || a.includes('/p2p-circuit'))) {
        libp2p.removeEventListener('self:peer:update', check)
        resolve()
      }
    }
    libp2p.addEventListener('self:peer:update', check)
    check()
    setTimeout(() => { libp2p.removeEventListener('self:peer:update', check); resolve() }, timeout)
  })
}

// ── Helper: wait for at least 1 peer in the gossipsub mesh ────────────────────
// Polls every 300ms. Resolves when a subscriber appears or after 4s timeout.
function waitForGossipsubPeer(topic, timeout = 4000) {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const subs = libp2p.services.pubsub.getSubscribers(topic)
      if (subs.length > 0) {
        clearInterval(interval)
        clearTimeout(timer)
        log(`Peer confirmed in mesh — ready to chat!`, 'success')
        resolve()
      }
    }, 300)
    const timer = setTimeout(() => {
      clearInterval(interval)
      log('Peer mesh not confirmed yet — messages may be delayed.', 'warn')
      resolve()
    }, timeout)
  })
}

// Re-register when addresses change
libp2p.addEventListener('self:peer:update', async () => {
  if (!currentTopic) return
  const myAddrs = libp2p.getMultiaddrs().map(ma => ma.toString())
  if (myAddrs.length === 0) return
  try {
    await fetch(`${RELAY_API}/peers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: currentTopic, peerId: libp2p.peerId.toString(), multiaddrs: myAddrs })
    })
  } catch { /* silent */ }
})

// ── Send message ───────────────────────────────────────────────────────────────
DOM.sendButton().onclick = async () => {
  const topic   = currentTopic
  const message = DOM.messageInput().value.trim()
  if (!topic || !message) return

  // Warn if no peers are in the mesh yet
  const subscribers = libp2p.services.pubsub.getSubscribers(topic)
  if (subscribers.length === 0) {
    log('No peers in mesh yet — message may not be delivered. Sending anyway…', 'warn')
  }

  try {
    await libp2p.services.pubsub.publish(topic, fromString(message))
    log(`You: ${message}`, 'sent')
    DOM.messageInput().value = ''

    await fetch(`${MESSAGES_API}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, peerId: libp2p.peerId.toString(), message })
    }).catch(() => {})

  } catch (err) {
    log(`Send failed: ${err.message}`, 'error')
  }
}

// Send on Enter
DOM.messageInput().addEventListener('keydown', e => {
  if (e.key === 'Enter') DOM.sendButton().click()
})

// ── Incoming messages ──────────────────────────────────────────────────────────
libp2p.services.pubsub.addEventListener('message', event => {
  const message = toString(event.detail.data)
  log(`Peer: ${message}`, 'received')
})

// ── Topic peer list poll ───────────────────────────────────────────────────────
setInterval(() => {
  if (!currentTopic) return
  const peers = libp2p.services.pubsub.getSubscribers(currentTopic).map(peerId => {
    const li = document.createElement('li')
    li.innerHTML = `<span class="peer-dot"></span>${peerId.toString().slice(0, 20)}…`
    return li
  })
  if (peers.length > 0) {
    DOM.topicPeerList().replaceChildren(...peers)
  }
}, 1000)

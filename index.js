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
  endButton:       () => document.getElementById('end-button'),
  messageInput:    () => document.getElementById('message-input'),
  sendButton:      () => document.getElementById('send-button'),
  output:          () => document.getElementById('output'),
  statusDot:       () => document.getElementById('status-dot'),
  statusText:      () => document.getElementById('status-text'),
  topicPeerList:   () => document.getElementById('topic-peers'),
  currentTopic:    () => document.getElementById('current-topic'),
}

// ── Log helper ─────────────────────────────────────────────────────────────────
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
      allowPublishToZeroTopicPeers: true,
      floodPublish: true,
    }),
    dcutr: dcutr()
  },
  connectionManager: { minConnections: 0 }
})

// Set peer ID
if (window.setPeerId) {
  window.setPeerId(libp2p.peerId.toString())
} else {
  DOM.peerId().textContent = libp2p.peerId.toString()
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentTopic     = null
let peerPollInterval = null
let meshPollInterval = null

// ── Connection events ─────────────────────────────────────────────────────────
libp2p.addEventListener('connection:open', (evt) => {
  console.log('[connection:open]', evt.detail?.remotePeer?.toString())
  if (currentTopic) updateConnectionStatus()
})

libp2p.addEventListener('connection:close', (evt) => {
  console.log('[connection:close]', evt.detail?.remotePeer?.toString())
  if (currentTopic) updateConnectionStatus()
})

function updateConnectionStatus() {
  const peers = libp2p.getPeers().length
  const meshPeers = currentTopic ? libp2p.services.pubsub.getSubscribers(currentTopic).length : 0
  if (meshPeers > 0) {
    setStatus('connected', `Connected — topic: ${currentTopic} (${meshPeers} peer${meshPeers > 1 ? 's' : ''} in mesh)`)
  } else if (peers > 0) {
    setStatus('relay', `Relay connected — waiting for mesh (${peers} peer${peers > 1 ? 's' : ''})`)
  } else {
    setStatus('waiting', 'Waiting for peers…')
  }
}

// ── Reset UI ──────────────────────────────────────────────────────────────────
function resetUI() {
  stopPeerPoll()
  stopMeshPoll()
  DOM.subscribeButton().disabled = false
  DOM.topicInput().disabled = false
  DOM.topicInput().value = ''
  DOM.messageInput().disabled = true
  DOM.messageInput().value = ''
  DOM.sendButton().disabled = true
  const endBtn = DOM.endButton()
  if (endBtn) endBtn.style.display = 'none'
  DOM.currentTopic().textContent = '—'
  setStatus('idle', 'Idle — enter a topic to connect')
  currentTopic = null
}

// ── Peer poll — keeps trying to connect to registry peers ─────────────────────
function startPeerPoll(topic) {
  peerPollInterval = setInterval(async () => {
    if (!currentTopic) return
    try {
      const res = await fetch(
        `${RELAY_API}/peers?topic=${encodeURIComponent(topic)}&exclude=${libp2p.peerId.toString()}`
      )
      const { peers } = await res.json()
      const connectedIds = libp2p.getPeers().map(p => p.toString())

      for (const peer of peers) {
        if (connectedIds.includes(peer.peerId)) continue
        const addrs = [
          ...peer.multiaddrs.filter(a => a.includes('/webrtc') || a.includes('/p2p-circuit')),
          ...peer.multiaddrs.filter(a => !a.includes('/webrtc') && !a.includes('/p2p-circuit'))
        ]
        for (const addr of addrs) {
          try { await libp2p.dial(multiaddr(addr)); break } catch { /* silent */ }
        }
      }
    } catch { /* silent */ }
  }, 4000)
}

function stopPeerPoll() {
  if (peerPollInterval) { clearInterval(peerPollInterval); peerPollInterval = null }
}

// ── Mesh poll — waits for gossipsub mesh to form ──────────────────────────────
function startMeshPoll(topic) {
  meshPollInterval = setInterval(() => {
    if (!currentTopic) return
    const meshPeers = libp2p.services.pubsub.getSubscribers(topic).length
    if (meshPeers > 0) {
      setStatus('connected', `Connected — topic: ${topic} (${meshPeers} peer${meshPeers > 1 ? 's' : ''} in mesh)`)
      log(`Peer mesh confirmed — ${meshPeers} peer(s) ready. You can send messages!`, 'success')
      stopMeshPoll()
    }
  }, 1000)
}

function stopMeshPoll() {
  if (meshPollInterval) { clearInterval(meshPollInterval); meshPollInterval = null }
}

// ── Helper: wait for relay/circuit address ────────────────────────────────────
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

// ── Re-register on address change ─────────────────────────────────────────────
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

// ── Connect ───────────────────────────────────────────────────────────────────
DOM.subscribeButton().onclick = async () => {
  const topic = DOM.topicInput().value.trim()
  if (!topic) return

  DOM.subscribeButton().disabled = true
  DOM.topicInput().disabled = true
  currentTopic = topic
  DOM.currentTopic().textContent = topic
  const endBtn = DOM.endButton()
  if (endBtn) endBtn.style.display = 'inline-flex'

  setStatus('connecting', 'Connecting to relay…')

  try {
    // 1. Fetch relay addresses
    const relayRes = await fetch(`${RELAY_API}/relay`)
    const { multiaddrs: relayAddrs } = await relayRes.json()
    if (!relayAddrs || relayAddrs.length === 0) throw new Error('Relay unavailable')

    // 2. Dial relay
    let connected = false
    for (const addr of relayAddrs) {
      try {
        await libp2p.dial(multiaddr(addr))
        connected = true
        log(`Relay connected ✓`, 'success')
        break
      } catch (e) {
        console.warn('[relay dial fail]', addr, e.message)
      }
    }
    if (!connected) throw new Error('Could not connect to relay')

    setStatus('relay', 'Waiting for circuit address…')

    // 3. Wait for circuit relay address
    await waitForWebRTCAddress()

    // 4. Subscribe gossipsub FIRST before registering
    libp2p.services.pubsub.subscribe(topic)
    log(`Subscribed to channel "${topic}"`, 'info')

    // 5. Register self in peer registry
    const myAddrs = libp2p.getMultiaddrs().map(ma => ma.toString())
    await fetch(`${RELAY_API}/peers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, peerId: libp2p.peerId.toString(), multiaddrs: myAddrs })
    })

    // 6. Find and connect to existing peers
    const peersRes = await fetch(
      `${RELAY_API}/peers?topic=${encodeURIComponent(topic)}&exclude=${libp2p.peerId.toString()}`
    )
    const { peers } = await peersRes.json()

    if (peers.length === 0) {
      setStatus('waiting', 'Waiting for others to join…')
      log('You are the first one here. Share the topic name to invite others.', 'info')
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
      setStatus('relay', 'Peers found — waiting for gossipsub mesh…')
      log(`Connected to channel "${topic}" ✓`, 'success')
      log('Peer mesh not confirmed yet — messages may be delayed.', 'warn')
    }

    // 7. Load message history
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

    // 8. Enable input
    DOM.messageInput().disabled = false
    DOM.sendButton().disabled = false
    DOM.messageInput().focus()

    // 9. Start polls
    startPeerPoll(topic)
    startMeshPoll(topic)

  } catch (err) {
    console.error('[connect error]', err)
    setStatus('error', 'Connection failed — try again')
    log(`Connection failed: ${err.message}`, 'error')
    resetUI()
  }
}

// ── End / Disconnect ──────────────────────────────────────────────────────────
const endBtn = DOM.endButton()
if (endBtn) {
  endBtn.style.display = 'none'
  endBtn.onclick = async () => {
    try {
      if (currentTopic) libp2p.services.pubsub.unsubscribe(currentTopic)
      for (const peer of libp2p.getPeers()) {
        try { await libp2p.hangUp(peer) } catch { /* silent */ }
      }
    } catch (err) {
      console.error('[disconnect error]', err)
    }
    log('Disconnected from channel.', 'info')
    resetUI()
  }
}

// ── Send message ───────────────────────────────────────────────────────────────
async function sendMessage() {
  const topic   = currentTopic
  const message = DOM.messageInput().value.trim()
  if (!topic || !message) return

  const meshPeers = libp2p.services.pubsub.getSubscribers(topic).length
  if (meshPeers === 0) {
    log('No peers in mesh yet — message may not be delivered. Sending anyway…', 'warn')
  }

  try {
    await libp2p.services.pubsub.publish(topic, fromString(message))
    log(`You: ${message}`, 'sent')
    DOM.messageInput().value = ''

    // Save to backend
    fetch(`${MESSAGES_API}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, peerId: libp2p.peerId.toString(), message })
    }).catch(() => {})

  } catch (err) {
    console.error('[send error]', err)
    log(`Send failed: ${err.message}`, 'error')
  }
}

DOM.sendButton().onclick = sendMessage

DOM.messageInput().addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
})

// ── Incoming messages ──────────────────────────────────────────────────────────
libp2p.services.pubsub.addEventListener('message', event => {
  if (event.detail.topic !== currentTopic) return
  const message = toString(event.detail.data)
  log(`Peer: ${message}`, 'received')
})

// ── Topic peer list UI poll ────────────────────────────────────────────────────
setInterval(() => {
  if (!currentTopic) return
  const peers = libp2p.services.pubsub.getSubscribers(currentTopic)
  const list = DOM.topicPeerList()
  if (!list) return
  if (peers.length > 0) {
    const items = peers.map(peerId => {
      const li = document.createElement('li')
      li.innerHTML = `<span class="peer-dot"></span>${peerId.toString().slice(0, 20)}…`
      return li
    })
    list.replaceChildren(...items)
  } else {
    list.innerHTML = '<li class="empty">No peers in mesh yet</li>'
  }
}, 1000)

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

// ── DOM ───────────────────────────────────────────────────────────────────────
const $topic     = () => document.getElementById('topic-input')
const $subscribe = () => document.getElementById('subscribe-button')
const $endBtn    = () => document.getElementById('end-button')
const $msgInput  = () => document.getElementById('message-input')
const $sendBtn   = () => document.getElementById('send-button')
const $output    = () => document.getElementById('output')
const $peerList  = () => document.getElementById('topic-peers')
const $curTopic  = () => document.getElementById('current-topic')
const $peerId    = () => document.getElementById('peer-id')

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(text, type = 'info') {
  if (window.addLog) { window.addLog(text, type); return }
  const line = document.createElement('div')
  line.className = `log-line log-${type}`
  line.textContent = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} › ${text}`
  $output().appendChild(line)
  $output().scrollTop = $output().scrollHeight
}

function setStatus(state, text) {
  if (window.setStatus) { window.setStatus(state, text); return }
  document.getElementById('status-dot').className = `s-dot dot-${state}`
  document.getElementById('status-text').textContent = text
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── libp2p ────────────────────────────────────────────────────────────────────
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
      canRelayMessage: true,
      emitSelf: false,
      scoreThresholds: {
        gossipThreshold:              -Infinity,
        publishThreshold:             -Infinity,
        graylistThreshold:            -Infinity,
        acceptPXThreshold:            -Infinity,
        opportunisticGraftThreshold:  -Infinity,
      },
    }),
    dcutr: dcutr()
  },
  connectionManager: { minConnections: 0 }
})

// Set peer ID
const myPeerId = libp2p.peerId.toString()
if (window.setPeerId) window.setPeerId(myPeerId)
else if ($peerId()) $peerId().textContent = myPeerId

// ── State ─────────────────────────────────────────────────────────────────────
let currentTopic     = null
let peerPollInterval = null
let meshPollInterval = null
let meshConfirmed    = false

// ── When a new peer connects — resubscribe to refresh gossipsub mesh ──────────
libp2p.addEventListener('connection:open', async (evt) => {
  const remotePeer = evt.detail?.remotePeer?.toString()
  console.log('[connection:open]', remotePeer)
  if (!currentTopic) return

  // Wait briefly then resubscribe to force gossipsub mesh refresh
  await sleep(500)
  try {
    libp2p.services.pubsub.unsubscribe(currentTopic)
    await sleep(200)
    libp2p.services.pubsub.subscribe(currentTopic)
    console.log('[gossipsub] resubscribed after peer connect')
  } catch (e) {
    console.warn('[gossipsub resubscribe]', e.message)
  }
})

libp2p.addEventListener('connection:close', (evt) => {
  console.log('[connection:close]', evt.detail?.remotePeer?.toString())
  if (!currentTopic) return
  const n = libp2p.services.pubsub.getSubscribers(currentTopic).length
  if (n === 0) {
    meshConfirmed = false
    setStatus('waiting', 'Peer disconnected — waiting for others…')
  }
})

// ── Polls ─────────────────────────────────────────────────────────────────────
function startPeerPoll(topic) {
  peerPollInterval = setInterval(async () => {
    if (!currentTopic) return
    try {
      const res = await fetch(`${RELAY_API}/peers?topic=${encodeURIComponent(topic)}&exclude=${myPeerId}`)
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

function startMeshPoll(topic) {
  meshPollInterval = setInterval(() => {
    if (!currentTopic) return
    const n = libp2p.services.pubsub.getSubscribers(topic).length
    if (n > 0 && !meshConfirmed) {
      meshConfirmed = true
      setStatus('connected', `Connected — topic: ${topic} (${n} peer${n > 1 ? 's' : ''} in mesh)`)
      log(`Peer mesh ready — ${n} peer(s) connected. Messages will be delivered!`, 'success')
    } else if (n === 0 && meshConfirmed) {
      meshConfirmed = false
      setStatus('waiting', 'Mesh lost — waiting for peers to reconnect…')
    } else if (n > 0 && meshConfirmed) {
      setStatus('connected', `Connected — topic: ${topic} (${n} peer${n > 1 ? 's' : ''} in mesh)`)
    }
  }, 1000)
}

function stopPeerPoll() { if (peerPollInterval) { clearInterval(peerPollInterval); peerPollInterval = null } }
function stopMeshPoll() { if (meshPollInterval) { clearInterval(meshPollInterval); meshPollInterval = null } }

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetUI() {
  stopPeerPoll()
  stopMeshPoll()
  currentTopic  = null
  meshConfirmed = false

  $subscribe().disabled = false
  $subscribe().textContent = 'Connect'
  $topic().disabled = false
  $topic().value = ''
  $msgInput().disabled = true
  $msgInput().value = ''
  $sendBtn().disabled = true
  if ($endBtn()) $endBtn().style.display = 'none'
  if ($curTopic()) $curTopic().textContent = '—'
  setStatus('idle', 'Idle — enter a topic to connect')
}

// ── Wait for circuit address ───────────────────────────────────────────────────
function waitForCircuitAddress(timeout = 15000) {
  return new Promise(resolve => {
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

// ── Re-register on address update ─────────────────────────────────────────────
libp2p.addEventListener('self:peer:update', async () => {
  if (!currentTopic) return
  const myAddrs = libp2p.getMultiaddrs().map(ma => ma.toString())
  if (!myAddrs.length) return
  try {
    await fetch(`${RELAY_API}/peers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: currentTopic, peerId: myPeerId, multiaddrs: myAddrs })
    })
  } catch { /* silent */ }
})

// ── Connect ───────────────────────────────────────────────────────────────────
$subscribe().addEventListener('click', async () => {
  const topic = $topic().value.trim()
  if (!topic) return

  $subscribe().disabled = true
  $topic().disabled = true
  currentTopic = topic
  meshConfirmed = false
  if ($curTopic()) $curTopic().textContent = topic
  if ($endBtn()) $endBtn().style.display = 'inline-flex'

  setStatus('connecting', 'Connecting to relay…')

  try {
    // 1. Fetch relay
    const relayRes = await fetch(`${RELAY_API}/relay`)
    const { multiaddrs: relayAddrs } = await relayRes.json()
    if (!relayAddrs?.length) throw new Error('Relay unavailable')

    // 2. Dial relay
    let relayConnected = false
    for (const addr of relayAddrs) {
      try { await libp2p.dial(multiaddr(addr)); relayConnected = true; break }
      catch (e) { console.warn('[relay dial]', e.message) }
    }
    if (!relayConnected) throw new Error('Could not connect to relay')

    setStatus('relay', 'Waiting for circuit address…')
    await waitForCircuitAddress()

    // 3. Subscribe FIRST before announcing
    libp2p.services.pubsub.subscribe(topic)
    log(`Subscribed to channel "${topic}"`, 'info')

    // 4. Wait briefly for gossipsub to initialize
    await sleep(500)

    // 5. Register self
    const myAddrs = libp2p.getMultiaddrs().map(ma => ma.toString())
    await fetch(`${RELAY_API}/peers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, peerId: myPeerId, multiaddrs: myAddrs })
    })

    // 6. Find and dial existing peers
    const peersRes = await fetch(`${RELAY_API}/peers?topic=${encodeURIComponent(topic)}&exclude=${myPeerId}`)
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

      // 7. Wait for connections then resubscribe to refresh gossipsub mesh
      await sleep(1000)
      libp2p.services.pubsub.unsubscribe(topic)
      await sleep(300)
      libp2p.services.pubsub.subscribe(topic)
      console.log('[gossipsub] resubscribed after initial peer dial')

      log(`Connected to channel "${topic}" ✓`, 'success')
      setStatus('relay', 'Building gossipsub mesh…')
    }

    // 8. Load history
    try {
      const histRes = await fetch(`${MESSAGES_API}/messages/${encodeURIComponent(topic)}`)
      const history = await histRes.json()
      if (history.length > 0) {
        log(`── ${history.length} previous message(s) ──`, 'info')
        history.forEach(m => {
          const isMe = m.peerId === myPeerId
          log(`${isMe ? 'You' : 'Peer'}: ${m.message}`, isMe ? 'sent' : 'received')
        })
      }
    } catch { /* history optional */ }

    log('Channel joined — messages are end-to-end encrypted.', 'success')

    // 9. Enable input
    $msgInput().removeAttribute('disabled')
    $msgInput().disabled = false
    $sendBtn().removeAttribute('disabled')
    $sendBtn().disabled = false
    $msgInput().focus()

    // 10. Start polls
    startPeerPoll(topic)
    startMeshPoll(topic)

  } catch (err) {
    console.error('[connect error]', err)
    setStatus('error', 'Connection failed — try again')
    log(`Connection failed: ${err.message}`, 'error')
    resetUI()
  }
})

// ── End button ────────────────────────────────────────────────────────────────
if ($endBtn()) {
  $endBtn().style.display = 'none'
  $endBtn().addEventListener('click', async () => {
    try {
      if (currentTopic) libp2p.services.pubsub.unsubscribe(currentTopic)
      for (const peer of libp2p.getPeers()) {
        try { await libp2p.hangUp(peer) } catch { /* silent */ }
      }
    } catch (err) { console.error('[disconnect]', err) }
    log('Disconnected from channel.', 'info')
    resetUI()
  })
}

// ── Send ──────────────────────────────────────────────────────────────────────
async function sendMessage() {
  const topic   = currentTopic
  const message = $msgInput().value.trim()
  if (!topic || !message) return

  const meshPeers = libp2p.services.pubsub.getSubscribers(topic).length
  if (meshPeers === 0) {
    log('No peers in mesh yet — sending anyway (may not be delivered)…', 'warn')
  }

  try {
    await libp2p.services.pubsub.publish(topic, fromString(message))
    log(`You: ${message}`, 'sent')
    $msgInput().value = ''
    const cc = document.getElementById('char-count')
    if (cc) cc.textContent = '0 / 500'

    // Save to backend
    fetch(`${MESSAGES_API}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, peerId: myPeerId, message })
    }).catch(() => {})

  } catch (err) {
    console.error('[send error]', err)
    log(`Send failed: ${err.message}`, 'error')
  }
}

$sendBtn().addEventListener('click', sendMessage)

// ── Incoming messages ──────────────────────────────────────────────────────────
libp2p.services.pubsub.addEventListener('message', event => {
  if (event.detail.topic !== currentTopic) return
  const message = toString(event.detail.data)
  log(`Peer: ${message}`, 'received')
})

// ── Peer list UI ──────────────────────────────────────────────────────────────
setInterval(() => {
  if (!currentTopic) return
  const list = $peerList()
  if (!list) return
  const peers = libp2p.services.pubsub.getSubscribers(currentTopic)
  if (peers.length > 0) {
    list.replaceChildren(...peers.map(pid => {
      const li = document.createElement('li')
      li.innerHTML = `<span class="peer-dot"></span>${pid.toString().slice(0, 20)}…`
      return li
    }))
  } else {
    list.innerHTML = '<li class="empty">No peers in mesh yet</li>'
  }
}, 1000)

// WebSocket hub client.
// Browsers connect only to Railway relay.
// No browser-to-browser libp2p dialing.

if (!sessionStorage.getItem('authToken')) {
  window.location.href = '/index.html'
  throw new Error('Unauthorized')
}

const RELAY_WS = import.meta.env.VITE_RELAY_WS_URL || 'ws://localhost:8080'
const MESSAGES_API = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const $topic = () => document.getElementById('topic-input')
const $subscribe = () => document.getElementById('subscribe-button')
const $endBtn = () => document.getElementById('end-button')
const $msgInput = () => document.getElementById('message-input')
const $sendBtn = () => document.getElementById('send-button')
const $output = () => document.getElementById('output')
const $peerList = () => document.getElementById('topic-peers')
const $curTopic = () => document.getElementById('current-topic')
const $peerId = () => document.getElementById('peer-id')

function log(text, type = 'info') {
  if (window.addLog) {
    window.addLog(text, type)
    return
  }

  const line = document.createElement('div')
  line.className = `log-line log-${type}`
  line.textContent = `${new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })} › ${text}`

  $output().appendChild(line)
  $output().scrollTop = $output().scrollHeight
}

function setStatus(state, text) {
  if (window.setStatus) {
    window.setStatus(state, text)
    return
  }

  document.getElementById('status-dot').className = `s-dot dot-${state}`
  document.getElementById('status-text').textContent = text
}

function makeClientId() {
  const existing = sessionStorage.getItem('hubClientId')
  if (existing) return existing

  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`

  sessionStorage.setItem('hubClientId', id)
  return id
}

function makeMessageId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function setInputEnabled(enabled) {
  $msgInput().disabled = !enabled
  $sendBtn().disabled = !enabled

  if (enabled) {
    $msgInput().removeAttribute('disabled')
    $sendBtn().removeAttribute('disabled')
    $msgInput().focus()
  }
}

function renderPeers(peers = []) {
  const list = $peerList()
  if (!list) return

  const others = peers.filter(peer => peer.clientId !== myClientId)

  if (others.length === 0) {
    list.innerHTML = '<li class="empty">Only you are connected</li>'
    return
  }

  list.replaceChildren(...others.map(peer => {
    const li = document.createElement('li')
    li.innerHTML = `<span class="peer-dot"></span>${peer.clientId.slice(0, 8)}…${peer.clientId.slice(-4)}`
    return li
  }))
}

async function loadHistory(topic) {
  try {
    const res = await fetch(`${MESSAGES_API}/messages/${encodeURIComponent(topic)}`)
    if (!res.ok) return

    const history = await res.json()
    if (!Array.isArray(history) || history.length === 0) return

    log(`── ${history.length} previous message(s) ──`, 'info')

    history.forEach(m => {
      const isMe = m.peerId === myClientId
      log(`${isMe ? 'You' : 'Peer'}: ${m.message}`, isMe ? 'sent' : 'received')
    })
  } catch {
    // Optional history.
  }
}

function saveMessage(topic, message) {
  fetch(`${MESSAGES_API}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      topic,
      peerId: myClientId,
      message
    })
  }).catch(() => {})
}

const myClientId = makeClientId()

if (window.setPeerId) window.setPeerId(myClientId)
else if ($peerId()) $peerId().textContent = myClientId

let socket = null
let currentTopic = null
let manuallyClosed = false
let reconnectTimer = null
let reconnectAttempt = 0
const seenMessages = new Set()

function resetUI() {
  currentTopic = null
  manuallyClosed = true
  reconnectAttempt = 0

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  if (socket) {
    try {
      socket.close(1000, 'manual disconnect')
    } catch {}
    socket = null
  }

  $subscribe().disabled = false
  $subscribe().textContent = 'Connect'
  $topic().disabled = false
  $topic().value = ''
  $msgInput().value = ''
  setInputEnabled(false)

  const cc = document.getElementById('char-count')
  if (cc) cc.textContent = '0 / 500'

  if ($endBtn()) $endBtn().style.display = 'none'
  if ($curTopic()) $curTopic().textContent = '—'
  if ($peerList()) $peerList().innerHTML = '<li class="empty">Subscribe first</li>'

  setStatus('idle', 'Idle — enter a topic to connect')
}

function connectHub(topic) {
  manuallyClosed = false
  currentTopic = topic

  if (socket) {
    try {
      socket.close(1000, 'switch topic')
    } catch {}
  }

  setStatus('connecting', 'Connecting to relay hub…')

  socket = new WebSocket(RELAY_WS)

  socket.addEventListener('open', () => {
    reconnectAttempt = 0

    socket.send(JSON.stringify({
      type: 'join',
      topic,
      clientId: myClientId
    }))
  })

  socket.addEventListener('message', event => {
    let msg

    try {
      msg = JSON.parse(event.data)
    } catch {
      log('Bad message from relay', 'error')
      return
    }

    if (msg.type === 'joined') {
      setStatus('connected', `Connected — topic: ${msg.topic}`)
      renderPeers(msg.peers || [])
      setInputEnabled(true)
      log(`Joined channel "${msg.topic}" through relay hub.`, 'success')
      return
    }

    if (msg.type === 'peer-joined') {
      renderPeers(msg.peers || [])
      if (msg.clientId !== myClientId) {
        log(`Client joined: ${msg.clientId.slice(0, 8)}…`, 'info')
      }
      return
    }

    if (msg.type === 'peer-left') {
      renderPeers(msg.peers || [])
      log(`Client left: ${msg.clientId.slice(0, 8)}…`, 'info')
      return
    }

    if (msg.type === 'message') {
      if (msg.topic !== currentTopic) return
      if (seenMessages.has(msg.messageId)) return

      seenMessages.add(msg.messageId)
      log(`Peer: ${msg.text}`, 'received')
      return
    }

    if (msg.type === 'error') {
      log(`Relay error: ${msg.message}`, 'error')
    }
  })

  socket.addEventListener('close', () => {
    setInputEnabled(false)

    if (manuallyClosed || !currentTopic) return

    setStatus('waiting', 'Relay disconnected — reconnecting…')

    const delay = Math.min(5000, 500 * 2 ** reconnectAttempt)
    reconnectAttempt += 1

    reconnectTimer = setTimeout(() => {
      if (currentTopic && !manuallyClosed) {
        connectHub(currentTopic)
      }
    }, delay)
  })

  socket.addEventListener('error', () => {
    setStatus('error', 'Relay connection error')
  })
}

$subscribe().addEventListener('click', async () => {
  const topic = $topic().value.trim()
  if (!topic) return

  $subscribe().disabled = true
  $topic().disabled = true
  currentTopic = topic
  seenMessages.clear()

  if ($curTopic()) $curTopic().textContent = topic
  if ($endBtn()) $endBtn().style.display = 'inline-flex'

  connectHub(topic)
  await loadHistory(topic)
})

if ($endBtn()) {
  $endBtn().style.display = 'none'

  $endBtn().addEventListener('click', () => {
    log('Disconnected from channel.', 'info')
    resetUI()
  })
}

async function sendMessage() {
  const topic = currentTopic
  const message = $msgInput().value.trim()

  if (!topic || !message) return

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log('Relay is not connected yet.', 'warn')
    return
  }

  const messageId = makeMessageId()

  try {
    socket.send(JSON.stringify({
      type: 'message',
      topic,
      clientId: myClientId,
      messageId,
      text: message
    }))

    seenMessages.add(messageId)
    log(`You: ${message}`, 'sent')
    saveMessage(topic, message)

    $msgInput().value = ''

    const cc = document.getElementById('char-count')
    if (cc) cc.textContent = '0 / 500'
  } catch (err) {
    console.error('[send error]', err)
    log(`Send failed: ${err.message}`, 'error')
  }
}

$sendBtn().addEventListener('click', sendMessage)

$msgInput().addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendMessage()
  }
})

setStatus('idle', 'Idle — enter a topic to connect')
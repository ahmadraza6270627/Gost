// Encrypted WebSocket hub client.
// Relay cannot read messages.
// Backend does not receive messages.
// Sender identity is not included in message payloads.
// Topic name is hidden from relay.
// Local session ID changes every page/login session.

if (!sessionStorage.getItem('authToken')) {
  window.location.href = '/index.html'
  throw new Error('Unauthorized')
}

const RELAY_WS = import.meta.env.VITE_RELAY_WS_URL || 'ws://localhost:8080'

const $topic = () => document.getElementById('topic-input')
const $subscribe = () => document.getElementById('subscribe-button')
const $endBtn = () => document.getElementById('end-button')
const $msgInput = () => document.getElementById('message-input')
const $sendBtn = () => document.getElementById('send-button')
const $output = () => document.getElementById('output')
const $peerList = () => document.getElementById('topic-peers')
const $curTopic = () => document.getElementById('current-topic')
const $peerId = () => document.getElementById('peer-id')

const encoder = new TextEncoder()
const decoder = new TextDecoder()

let socket = null
let currentTopic = null
let encryptedRoomId = null
let roomCryptoKey = null
let manuallyClosed = false
let reconnectTimer = null
let reconnectAttempt = 0

const seenMessages = new Set()

const localSessionId = crypto.randomUUID
  ? crypto.randomUUID()
  : `session-${Date.now()}-${Math.random().toString(16).slice(2)}`

if (window.setPeerId) {
  window.setPeerId(localSessionId)
} else if ($peerId()) {
  $peerId().textContent = localSessionId
}

function log(text, type = 'info') {
  if (window.addLog) {
    window.addLog(text, type)
    return
  }

  const output = $output()
  if (!output) return

  const line = document.createElement('div')
  line.className = `log-line log-${type}`

  line.textContent = `${new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })} › ${text}`

  output.appendChild(line)
  output.scrollTop = output.scrollHeight
}

function setStatus(state, text) {
  if (window.setStatus) {
    window.setStatus(state, text)
    return
  }

  const dot = document.getElementById('status-dot')
  const label = document.getElementById('status-text')

  if (dot) dot.className = `s-dot dot-${state}`
  if (label) label.textContent = text
}

function setInputEnabled(enabled) {
  const input = $msgInput()
  const button = $sendBtn()

  if (!input || !button) return

  input.disabled = !enabled
  button.disabled = !enabled

  if (enabled) {
    input.removeAttribute('disabled')
    button.removeAttribute('disabled')
    input.focus()
  }
}

function makeMessageId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function b64u(bytes) {
  const arr = new Uint8Array(bytes)
  let binary = ''

  for (const byte of arr) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function fromB64u(str) {
  let normalized = str.replaceAll('-', '+').replaceAll('_', '/')

  while (normalized.length % 4) {
    normalized += '='
  }

  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

async function sha256(text) {
  return crypto.subtle.digest('SHA-256', encoder.encode(text))
}

async function deriveRoomCrypto(topic, roomKey) {
  const salt = await sha256(`gost:e2ee:salt:${topic}`)

  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(roomKey),
    'PBKDF2',
    false,
    ['deriveKey']
  )

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 150000,
      hash: 'SHA-256'
    },
    baseKey,
    {
      name: 'AES-GCM',
      length: 256
    },
    false,
    ['encrypt', 'decrypt']
  )

  const roomHash = await sha256(`gost:e2ee:room:${topic}:${roomKey}`)

  return {
    key,
    roomId: `room-${b64u(roomHash).slice(0, 40)}`
  }
}

async function encryptText(text) {
  if (!roomCryptoKey) {
    throw new Error('Missing room encryption key')
  }

  const iv = crypto.getRandomValues(new Uint8Array(12))

  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    roomCryptoKey,
    encoder.encode(text)
  )

  return {
    v: 1,
    alg: 'AES-GCM',
    iv: b64u(iv),
    ct: b64u(encrypted)
  }
}

async function decryptText(payload) {
  if (!roomCryptoKey) {
    throw new Error('Missing room encryption key')
  }

  if (!payload || !payload.iv || !payload.ct) {
    throw new Error('Invalid encrypted payload')
  }

  const iv = fromB64u(payload.iv)
  const ciphertext = fromB64u(payload.ct)

  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv
    },
    roomCryptoKey,
    ciphertext
  )

  return decoder.decode(decrypted)
}

function renderAnonymousMode() {
  const list = $peerList()
  if (!list) return

  list.innerHTML = '<li class="empty">Anonymous encrypted mode enabled</li>'
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function closeSocket(reason = 'manual disconnect') {
  if (!socket) return

  try {
    socket.close(1000, reason)
  } catch {}

  socket = null
}

function resetUI() {
  currentTopic = null
  encryptedRoomId = null
  roomCryptoKey = null
  manuallyClosed = true
  reconnectAttempt = 0

  seenMessages.clear()
  clearReconnectTimer()
  closeSocket('manual disconnect')

  const topicInput = $topic()
  const subBtn = $subscribe()
  const msgInput = $msgInput()
  const endBtn = $endBtn()
  const curTopic = $curTopic()
  const peerList = $peerList()
  const cc = document.getElementById('char-count')

  if (subBtn) {
    subBtn.disabled = false
    subBtn.textContent = 'Connect'
  }

  if (topicInput) {
    topicInput.disabled = false
    topicInput.value = ''
  }

  if (msgInput) {
    msgInput.value = ''
  }

  setInputEnabled(false)

  if (cc) cc.textContent = '0 / 500'
  if (endBtn) endBtn.style.display = 'none'
  if (curTopic) curTopic.textContent = '—'
  if (peerList) peerList.innerHTML = '<li class="empty">Subscribe first</li>'

  setStatus('idle', 'Idle — enter a topic to connect')
}

function connectHub(roomId) {
  manuallyClosed = false

  closeSocket('switch encrypted room')

  setStatus('connecting', 'Connecting to encrypted relay…')

  socket = new WebSocket(RELAY_WS)

  socket.addEventListener('open', () => {
    reconnectAttempt = 0

    socket.send(
      JSON.stringify({
        type: 'join',
        roomId
      })
    )
  })

  socket.addEventListener('message', async event => {
    let msg

    try {
      msg = JSON.parse(event.data)
    } catch {
      log('Bad message from relay', 'error')
      return
    }

    if (msg.type === 'joined') {
      setStatus('connected', 'Encrypted room connected')
      setInputEnabled(true)
      renderAnonymousMode()
      log('End-to-end encrypted room joined.', 'success')
      return
    }

    if (msg.type === 'message') {
      if (seenMessages.has(msg.messageId)) return

      seenMessages.add(msg.messageId)

      try {
        const plaintext = await decryptText(msg.payload)
        log(`Anonymous: ${plaintext}`, 'received')
      } catch {
        log('Could not decrypt message. Wrong room key.', 'warn')
      }

      return
    }

    if (msg.type === 'error') {
      log(`Relay error: ${msg.message}`, 'error')
      return
    }
  })

  socket.addEventListener('close', () => {
    setInputEnabled(false)

    if (manuallyClosed || !encryptedRoomId) return

    setStatus('waiting', 'Relay disconnected — reconnecting…')

    const delay = Math.min(5000, 500 * 2 ** reconnectAttempt)
    reconnectAttempt += 1

    clearReconnectTimer()

    reconnectTimer = setTimeout(() => {
      if (encryptedRoomId && !manuallyClosed) {
        connectHub(encryptedRoomId)
      }
    }, delay)
  })

  socket.addEventListener('error', () => {
    setStatus('error', 'Relay connection error')
  })
}

async function startEncryptedRoom() {
  const topicInput = $topic()
  const subBtn = $subscribe()
  const endBtn = $endBtn()
  const curTopic = $curTopic()

  if (!topicInput || !subBtn) return

  const topic = topicInput.value.trim()
  if (!topic) return

  const roomKey = prompt('Enter room encryption key')

  if (!roomKey || roomKey.length < 8) {
    log('Room key must be at least 8 characters.', 'warn')
    return
  }

  try {
    setStatus('connecting', 'Creating encrypted room…')

    const derived = await deriveRoomCrypto(topic, roomKey)

    currentTopic = topic
    encryptedRoomId = derived.roomId
    roomCryptoKey = derived.key

    seenMessages.clear()

    subBtn.disabled = true
    topicInput.disabled = true

    if (curTopic) curTopic.textContent = topic
    if (endBtn) endBtn.style.display = 'inline-flex'

    connectHub(encryptedRoomId)

    log('E2EE enabled. Relay cannot read messages.', 'success')
  } catch (err) {
    console.error('[crypto setup error]', err)
    log(`Encryption setup failed: ${err.message}`, 'error')
    resetUI()
  }
}

async function sendMessage() {
  const input = $msgInput()
  if (!input) return

  const message = input.value.trim()

  if (!currentTopic || !encryptedRoomId || !message) return

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log('Relay is not connected yet.', 'warn')
    return
  }

  try {
    const messageId = makeMessageId()
    const payload = await encryptText(message)

    socket.send(
      JSON.stringify({
        type: 'message',
        messageId,
        payload
      })
    )

    seenMessages.add(messageId)

    log(`You: ${message}`, 'sent')

    input.value = ''

    const cc = document.getElementById('char-count')
    if (cc) cc.textContent = '0 / 500'
  } catch (err) {
    console.error('[send error]', err)
    log(`Send failed: ${err.message}`, 'error')
  }
}

function bindEvents() {
  const subBtn = $subscribe()
  const endBtn = $endBtn()
  const sendBtn = $sendBtn()
  const msgInput = $msgInput()

  if (subBtn) {
    subBtn.addEventListener('click', startEncryptedRoom)
  }

  if (endBtn) {
    endBtn.style.display = 'none'

    endBtn.addEventListener('click', () => {
      log('Disconnected from encrypted room.', 'info')
      resetUI()
    })
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', sendMessage)
  }

  if (msgInput) {
    msgInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        sendMessage()
      }
    })

    msgInput.addEventListener('input', () => {
      const cc = document.getElementById('char-count')
      if (cc) {
        cc.textContent = `${msgInput.value.length} / 500`
      }
    })
  }

  window.addEventListener('beforeunload', () => {
    manuallyClosed = true
    closeSocket('page unload')
  })
}

bindEvents()
setInputEnabled(false)
setStatus('idle', 'Idle — enter a topic to connect')
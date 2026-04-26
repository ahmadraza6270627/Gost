// WebSocket hub client.
// Browsers connect only to Railway relay.
// No browser-to-browser libp2p dialing.
// UI does not show peer/client IDs anywhere.
// Supports text messages and short voice notes.

if (!sessionStorage.getItem('authToken')) {
  window.location.href = '/index.html'
  throw new Error('Unauthorized')
}

const RELAY_WS = import.meta.env.VITE_RELAY_WS_URL || 'ws://localhost:8080'
const MESSAGES_API = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const MAX_VOICE_MS = 30_000
const MAX_VOICE_BYTES = 1_200_000

const $topic = () => document.getElementById('topic-input')
const $subscribe = () => document.getElementById('subscribe-button')
const $endBtn = () => document.getElementById('end-button')
const $msgInput = () => document.getElementById('message-input')
const $sendBtn = () => document.getElementById('send-button')
const $voiceBtn = () => document.getElementById('voice-button')
const $output = () => document.getElementById('output')
const $peerList = () => document.getElementById('topic-peers')
const $curTopic = () => document.getElementById('current-topic')
const $peerId = () => document.getElementById('peer-id')
const $charCount = () => document.getElementById('char-count')

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
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function makeMessageId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function setInputEnabled(enabled) {
  $msgInput().disabled = !enabled
  $sendBtn().disabled = !enabled

  if ($voiceBtn()) {
    $voiceBtn().disabled = !enabled
  }

  if (enabled) {
    $msgInput().removeAttribute('disabled')
    $sendBtn().removeAttribute('disabled')

    if ($voiceBtn()) {
      $voiceBtn().removeAttribute('disabled')
    }

    $msgInput().focus()
  }
}

function getMemberCount(input) {
  if (typeof input === 'number') return input

  if (Array.isArray(input)) {
    return Math.max(input.length, 1)
  }

  return 1
}

function renderPeers(input = []) {
  const list = $peerList()
  if (!list) return

  const count = getMemberCount(input)

  list.innerHTML = `
    <li class="member-count-card">
      <span class="member-count">${count}</span>
      <span class="member-copy">
        <strong>${count === 1 ? 'active member' : 'active members'}</strong>
        <small>IDs hidden</small>
      </span>
    </li>
  `
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
      log(`${isMe ? 'You' : 'Member'}: ${m.message}`, isMe ? 'sent' : 'received')
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

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onloadend = () => {
      const result = String(reader.result || '')
      resolve(result.split(',')[1] || '')
    }

    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function getSupportedAudioMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus'
  ]

  if (!window.MediaRecorder) return ''

  return types.find(type => MediaRecorder.isTypeSupported(type)) || ''
}

function formatDuration(ms = 0) {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function renderVoiceNote(base64, mimeType = 'audio/webm', isMe = false, durationMs = 0) {
  const output = $output()
  if (!output) return

  const line = document.createElement('div')
  line.className = `log-line voice-note ${isMe ? 'log-sent' : 'log-received'}`

  const label = document.createElement('div')
  label.className = 'voice-label'
  label.textContent = `${isMe ? 'You' : 'Member'} sent a voice note${durationMs ? ` · ${formatDuration(durationMs)}` : ''}`

  const audio = document.createElement('audio')
  audio.controls = true
  audio.preload = 'metadata'
  audio.src = `data:${mimeType};base64,${base64}`

  line.appendChild(label)
  line.appendChild(audio)

  output.appendChild(line)
  output.scrollTop = output.scrollHeight
}

const myClientId = makeClientId()

if (window.setPeerId) window.setPeerId('Hidden')
else if ($peerId()) $peerId().textContent = 'Hidden'

let socket = null
let currentTopic = null
let manuallyClosed = false
let reconnectTimer = null
let reconnectAttempt = 0

let mediaRecorder = null
let voiceStream = null
let voiceChunks = []
let isRecording = false
let voiceStartedAt = 0
let voiceStopTimer = null

const seenMessages = new Set()

function cleanupVoiceRecorder() {
  if (voiceStopTimer) {
    clearTimeout(voiceStopTimer)
    voiceStopTimer = null
  }

  if (voiceStream) {
    voiceStream.getTracks().forEach(track => track.stop())
    voiceStream = null
  }

  mediaRecorder = null
  voiceChunks = []
  isRecording = false

  if ($voiceBtn()) {
    $voiceBtn().classList.remove('recording')
    $voiceBtn().textContent = '🎙'
    $voiceBtn().title = 'Record voice note'
  }
}

function resetUI() {
  currentTopic = null
  manuallyClosed = true
  reconnectAttempt = 0

  cleanupVoiceRecorder()

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

  if ($charCount()) $charCount().textContent = '0 / 500'
  if ($endBtn()) $endBtn().style.display = 'none'
  if ($curTopic()) $curTopic().textContent = '—'

  if ($peerList()) {
    $peerList().innerHTML = '<li class="empty">Connect to see active members</li>'
  }

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
      setStatus('connected', `Connected — ${msg.topic}`)
      renderPeers(msg.memberCount ?? msg.peers ?? 1)
      setInputEnabled(true)
      log(`Joined topic "${msg.topic}".`, 'success')
      return
    }

    if (msg.type === 'peer-joined') {
      renderPeers(msg.memberCount ?? msg.peers ?? 1)
      log('A member joined the topic.', 'info')
      return
    }

    if (msg.type === 'peer-left') {
      renderPeers(msg.memberCount ?? msg.peers ?? 1)
      log('A member left the topic.', 'info')
      return
    }

    if (msg.type === 'message') {
      if (msg.topic !== currentTopic) return
      if (seenMessages.has(msg.messageId)) return

      seenMessages.add(msg.messageId)
      log(`Member: ${msg.text}`, 'received')
      return
    }

    if (msg.type === 'voice') {
      if (msg.topic !== currentTopic) return
      if (seenMessages.has(msg.messageId)) return

      seenMessages.add(msg.messageId)
      renderVoiceNote(msg.audio, msg.mimeType, false, msg.durationMs)
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

async function startVoiceRecording() {
  if (!currentTopic || !socket || socket.readyState !== WebSocket.OPEN) {
    log('Relay is not connected yet.', 'warn')
    return
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    log('Voice recording is not supported in this browser.', 'warn')
    return
  }

  try {
    const mimeType = getSupportedAudioMimeType()
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    voiceChunks = []

    const options = mimeType ? { mimeType } : undefined
    mediaRecorder = new MediaRecorder(voiceStream, options)

    mediaRecorder.addEventListener('dataavailable', event => {
      if (event.data && event.data.size > 0) {
        voiceChunks.push(event.data)
      }
    })

    mediaRecorder.addEventListener('stop', async () => {
      const finalMimeType = mediaRecorder?.mimeType || mimeType || 'audio/webm'
      const durationMs = Date.now() - voiceStartedAt
      const blob = new Blob(voiceChunks, { type: finalMimeType })

      if (blob.size <= 0) {
        cleanupVoiceRecorder()
        log('Voice note was empty.', 'warn')
        return
      }

      if (blob.size > MAX_VOICE_BYTES) {
        cleanupVoiceRecorder()
        log('Voice note is too large. Keep it shorter.', 'warn')
        return
      }

      try {
        const base64 = await blobToBase64(blob)
        sendVoiceNote(base64, finalMimeType, durationMs)
      } catch (err) {
        console.error('[voice encode error]', err)
        log('Could not prepare voice note.', 'error')
      } finally {
        cleanupVoiceRecorder()
      }
    })

    mediaRecorder.start()
    isRecording = true
    voiceStartedAt = Date.now()

    if ($voiceBtn()) {
      $voiceBtn().classList.add('recording')
      $voiceBtn().textContent = '⏹'
      $voiceBtn().title = 'Stop recording'
    }

    log('Recording voice note…', 'info')

    voiceStopTimer = setTimeout(() => {
      stopVoiceRecording()
    }, MAX_VOICE_MS)
  } catch (err) {
    console.error('[voice permission error]', err)
    cleanupVoiceRecorder()
    log('Microphone permission denied or unavailable.', 'error')
  }
}

function stopVoiceRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return
  mediaRecorder.stop()
}

function sendVoiceNote(base64, mimeType, durationMs) {
  if (!currentTopic || !socket || socket.readyState !== WebSocket.OPEN) {
    log('Relay is not connected yet.', 'warn')
    return
  }

  const messageId = makeMessageId()

  try {
    socket.send(JSON.stringify({
      type: 'voice',
      topic: currentTopic,
      clientId: myClientId,
      messageId,
      audio: base64,
      mimeType,
      durationMs
    }))

    seenMessages.add(messageId)
    renderVoiceNote(base64, mimeType, true, durationMs)
  } catch (err) {
    console.error('[voice send error]', err)
    log(`Voice send failed: ${err.message}`, 'error')
  }
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
    log('Disconnected from topic.', 'info')
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

    if ($charCount()) $charCount().textContent = '0 / 500'
  } catch (err) {
    console.error('[send error]', err)
    log(`Send failed: ${err.message}`, 'error')
  }
}

$sendBtn().addEventListener('click', sendMessage)

if ($voiceBtn()) {
  $voiceBtn().addEventListener('click', async () => {
    if (isRecording) {
      stopVoiceRecording()
    } else {
      await startVoiceRecording()
    }
  })
}

$msgInput().addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendMessage()
  }
})

$msgInput().addEventListener('input', () => {
  if ($charCount()) {
    $charCount().textContent = `${$msgInput().value.length} / 500`
  }
})

window.addEventListener('beforeunload', () => {
  cleanupVoiceRecorder()
})

setStatus('idle', 'Idle — enter a topic to connect')
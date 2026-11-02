import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

const SESSION_STORAGE_KEY = 'voicepay-session-id'
const SPEECH_RATE_KEY = 'voicepay-speech-rate'
const WARNING_WINDOW_MS = 60 * 1000

const getSessionId = () => {
  const saved = localStorage.getItem(SESSION_STORAGE_KEY)
  if (saved) return saved
  const id = crypto.randomUUID()
  localStorage.setItem(SESSION_STORAGE_KEY, id)
  return id
}

function ProductCard({ item }) {
  const details = [
    ['Description', item.description],
    ['Size', item.size],
    ['Color', item.color],
    ['Materials', item.materials],
    ['In the box', item.box],
    ['Care', item.care],
    ['Tactile features', item.tactile],
    ['Sound and voice', item.soundVoice],
  ].filter(([, value]) => value)

  return (
    <article className="product-card" aria-label={`Product: ${item.name}`}>
      <h3>{item.name}</h3>
      <p>
        {item.quantity ? `Quantity: ${item.quantity}. ` : ''}
        {item.unitAmount ? `Price: $${Number(item.unitAmount).toFixed(2)} each.` : ''}
      </p>
      {details.map(([label, value]) => (
        <p key={label} className="product-description">
          <strong>{label}:</strong> {value}
        </p>
      ))}
    </article>
  )
}

function App() {
  const [messages, setMessages] = useState([])
  const [message, setMessage] = useState('')
  const [pendingAction, setPendingAction] = useState(null)
  const [isListening, setIsListening] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [speechRate, setSpeechRate] = useState(() =>
    Number(localStorage.getItem(SPEECH_RATE_KEY) || '1'),
  )
  const [status, setStatus] = useState('Ready')
  const [expiryWarning, setExpiryWarning] = useState('')
  const [lastSpoken, setLastSpoken] = useState('')
  const recognitionRef = useRef(null)
  const isListeningRef = useRef(false)
  const stoppingRecognitionRef = useRef(false)
  const shortcutPressedRef = useRef(false)
  const ignoreClickRef = useRef(false)
  const pendingRef = useRef(null)
  const conversationRef = useRef(null)
  const sessionIdRef = useRef(getSessionId())

  const vibrate = useCallback((pattern) => {
    if ('vibrate' in navigator) navigator.vibrate(pattern)
  }, [])

  const speak = useCallback(
    (text) => {
      if (!text || !('speechSynthesis' in window)) return
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = speechRate
      window.speechSynthesis.speak(utterance)
      setLastSpoken(text)
    },
    [speechRate],
  )

  const announce = useCallback(
    (text, kind = 'assistant') => {
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), kind, text },
      ])
      speak(text)
    },
    [speak],
  )

  const sendMessage = useCallback(
    async (text) => {
      const trimmed = text.trim()
      if (!trimmed || isSending) return

      setMessage('')
      setIsSending(true)
      setStatus('Sending')
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), kind: 'user', text: trimmed },
      ])

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Id': sessionIdRef.current,
          },
          body: JSON.stringify({ message: trimmed }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'The assistant could not respond.')
        if (data.sessionId) {
          sessionIdRef.current = data.sessionId
          localStorage.setItem(SESSION_STORAGE_KEY, data.sessionId)
        }
        announce(data.reply || 'I did not receive a response.')
        setPendingAction(data.pendingAction || null)
        if (data.pendingAction) {
          vibrate([120, 80, 120])
        }
        setStatus('Ready')
      } catch (error) {
        const text = error.message || 'Something went wrong. Please try again.'
        announce(`Sorry. ${text}`, 'error')
        vibrate([80, 60, 80])
        setStatus('Error')
      } finally {
        setIsSending(false)
      }
    },
    [announce, isSending, vibrate],
  )

  const handlePending = useCallback(
    async (decision) => {
      if (!pendingAction || isSending) return
      setIsSending(true)
      setStatus(decision === 'confirm' ? 'Confirming' : 'Cancelling')
      try {
        const endpoint = decision === 'confirm' ? '/api/confirm' : '/api/cancel'
        const body =
          decision === 'confirm'
            ? { actionId: pendingAction.id, confirmation: true }
            : { actionId: pendingAction.id }
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Id': sessionIdRef.current,
          },
          body: JSON.stringify(body),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'The action could not be completed.')
        setPendingAction(null)
        setExpiryWarning('')
        const resultText =
          decision === 'confirm'
            ? data.action?.status === 'completed'
              ? 'Your payment is complete.'
              : data.action?.result?.message || 'Your action needs more PayPal approval.'
            : 'The pending action was cancelled.'
        announce(resultText)
        vibrate(decision === 'confirm' ? [180, 80, 180] : [60])
        setStatus('Ready')
      } catch (error) {
        announce(`Sorry. ${error.message || 'That action could not be completed.'}`, 'error')
        vibrate([80, 60, 80])
        setStatus('Error')
      } finally {
        setIsSending(false)
      }
    },
    [announce, isSending, pendingAction, vibrate],
  )

  const finishListening = useCallback(() => {
    stoppingRecognitionRef.current = true
    recognitionRef.current?.stop()
    isListeningRef.current = false
    setIsListening(false)
  }, [])

  const startListening = useCallback(() => {
    const Recognition =
      window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) {
      announce('Speech recognition is not available in this browser. You can type instead.', 'error')
      return
    }

    if (isListeningRef.current) return

    stoppingRecognitionRef.current = false
    const recognition = new Recognition()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = document.documentElement.lang || 'en-US'
    recognition.onstart = () => {
      if (stoppingRecognitionRef.current) {
        recognition.stop()
        return
      }
      isListeningRef.current = true
      setIsListening(true)
      setStatus('Listening')
      vibrate([80, 60, 80])
    }
    recognition.onresult = (event) => {
      stoppingRecognitionRef.current = false
      const transcript = event.results[0][0].transcript
      setMessage(transcript)
      if (/^(repeat|repeat last answer)$/i.test(transcript.trim())) {
        speak(lastSpoken || 'There is no previous answer to repeat.')
        setMessage('')
      } else if (/^(confirm|cancel)$/i.test(transcript.trim()) && pendingAction) {
        handlePending(transcript.trim().toLowerCase())
      } else {
        sendMessage(transcript)
      }
    }
    recognition.onerror = (event) => {
      if (stoppingRecognitionRef.current || event.error === 'aborted') {
        return
      }
      isListeningRef.current = false
      setIsListening(false)
      setStatus('Error')
      announce('I could not hear that. Please try again or type your message.', 'error')
      vibrate([80, 60, 80])
    }
    recognition.onend = () => {
      stoppingRecognitionRef.current = false
      isListeningRef.current = false
      setIsListening(false)
      setStatus((current) => (current === 'Listening' ? 'Ready' : current))
    }
    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch (error) {
      isListeningRef.current = false
      setIsListening(false)
      setStatus('Error')
      announce(error.message || 'Voice input could not be started. Please try again.', 'error')
    }
  }, [
    announce,
    handlePending,
    lastSpoken,
    pendingAction,
    sendMessage,
    speak,
    vibrate,
  ])

  const handleSpeakClick = useCallback(() => {
    if (ignoreClickRef.current) {
      ignoreClickRef.current = false
      return
    }
    if (isListeningRef.current) {
      finishListening()
    } else {
      startListening()
    }
  }, [finishListening, startListening])

  const handleSpeakPointerDown = useCallback(
    (event) => {
      event.preventDefault()
      ignoreClickRef.current = true
      event.currentTarget.setPointerCapture?.(event.pointerId)
      startListening()
    },
    [startListening],
  )

  const handleSpeakPointerUp = useCallback(
    (event) => {
      event.preventDefault()
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      finishListening()
    },
    [finishListening],
  )

  const handleSpeakKeyDown = useCallback(
    (event) => {
      if (event.code === 'Space') {
        event.preventDefault()
        if (!event.repeat) startListening()
      }
    },
    [startListening],
  )

  const handleSpeakKeyUp = useCallback(
    (event) => {
      if (event.code === 'Space') {
        event.preventDefault()
        finishListening()
      }
    },
    [finishListening],
  )

  useEffect(() => {
    const handleKeyDown = (event) => {
      const target = event.target
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      if (event.key === 'Escape' && pendingAction) {
        event.preventDefault()
        handlePending('cancel')
      } else if (event.key.toLowerCase() === 'r' && !typing) {
        event.preventDefault()
        speak(lastSpoken || 'There is no previous answer to repeat.')
      } else if (
        event.code === 'Space' &&
        !typing &&
        !(target instanceof HTMLButtonElement) &&
        !event.repeat
      ) {
        event.preventDefault()
        shortcutPressedRef.current = true
        startListening()
      }
    }
    const handleKeyUp = (event) => {
      if (event.code === 'Space' && shortcutPressedRef.current) {
        event.preventDefault()
        shortcutPressedRef.current = false
        finishListening()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('keyup', handleKeyUp)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('keyup', handleKeyUp)
    }
  }, [finishListening, handlePending, lastSpoken, pendingAction, speak, startListening])

  useEffect(() => {
    if (!pendingAction) return undefined
    pendingRef.current?.focus()
    window.setTimeout(() => speak(pendingAction.humanSummary), 0)
  }, [pendingAction, speak])

  useEffect(() => {
    if (!pendingAction) return undefined
    const checkExpiry = () => {
      const remaining = new Date(pendingAction.expiresAt).getTime() - Date.now()
      if (remaining <= 0 && expiryWarning !== 'This pending action has expired.') {
        window.setTimeout(() => setExpiryWarning('This pending action has expired.'), 0)
        window.setTimeout(
          () => speak('This pending action has expired. It can no longer be confirmed.'),
          0,
        )
      } else if (remaining <= WARNING_WINDOW_MS && !expiryWarning) {
        window.setTimeout(() => setExpiryWarning('This action expires in less than one minute.'), 0)
        window.setTimeout(
          () => speak('Warning. This action expires in less than one minute.'),
          0,
        )
      }
    }
    checkExpiry()
    const interval = window.setInterval(checkExpiry, 5000)
    return () => window.clearInterval(interval)
  }, [pendingAction, speak, expiryWarning])

  useEffect(() => {
    conversationRef.current?.scrollTo({
      top: conversationRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages])

  const updateSpeechRate = (event) => {
    const value = Number(event.target.value)
    setSpeechRate(value)
    localStorage.setItem(SPEECH_RATE_KEY, String(value))
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#conversation">
        Skip to conversation
      </a>
      <header className="site-header">
        <div>
          <p className="eyebrow">Accessible PayPal assistant</p>
          <h1>VoicePay</h1>
        </div>
        <p className="status" role="status">{status}</p>
      </header>

      <main>
        <section className="control-panel" aria-labelledby="assistant-heading">
          <h2 id="assistant-heading">Talk to VoicePay</h2>
          <p>
            Use your voice or type. Voice and text responses are always shown together.
            Hold the button, or hold Space anywhere outside a text field, while you speak.
          </p>
          <button
            type="button"
            className={`speak-button ${isListening ? 'is-listening' : ''}`}
            onClick={handleSpeakClick}
            onPointerDown={handleSpeakPointerDown}
            onPointerUp={handleSpeakPointerUp}
            onPointerCancel={handleSpeakPointerUp}
            onKeyDown={handleSpeakKeyDown}
            onKeyUp={handleSpeakKeyUp}
            aria-pressed={isListening}
            aria-label={isListening ? 'Release to stop listening' : 'Hold to speak'}
          >
            <span aria-hidden="true">{isListening ? '■' : '●'}</span>
            {isListening ? 'Release to stop' : 'Hold to speak'}
          </button>
          <form
            className="message-form"
            onSubmit={(event) => {
              event.preventDefault()
              sendMessage(message)
            }}
          >
            <label htmlFor="message">Type a message</label>
            <div className="input-row">
              <input
                id="message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="For example: send 20 dollars to Nimal"
                autoComplete="off"
              />
              <button type="submit" className="primary-button" disabled={isSending || !message.trim()}>
                Send
              </button>
            </div>
          </form>
          <div className="settings-row">
            <label htmlFor="speech-rate">Speech rate</label>
            <input
              id="speech-rate"
              type="range"
              min="0.6"
              max="1.5"
              step="0.1"
              value={speechRate}
              onChange={updateSpeechRate}
              aria-describedby="speech-rate-value"
            />
            <output id="speech-rate-value" htmlFor="speech-rate">{speechRate.toFixed(1)}x</output>
            <button type="button" className="secondary-button" onClick={() => speak(lastSpoken || 'There is no previous answer to repeat.')}>
              Repeat last answer
            </button>
          </div>
        </section>

        <section
          id="conversation"
          className="conversation"
          aria-labelledby="conversation-heading"
          aria-live="polite"
          ref={conversationRef}
        >
          <h2 id="conversation-heading">Conversation</h2>
          {messages.length === 0 ? (
            <p className="empty-state">Your conversation will appear here.</p>
          ) : (
            <ol className="message-list">
              {messages.map((entry) => (
                <li key={entry.id} className={`message message-${entry.kind}`}>
                  <span className="message-label">{entry.kind === 'user' ? 'You' : 'VoicePay'}</span>
                  <p>{entry.text}</p>
                </li>
              ))}
            </ol>
          )}
        </section>

        {pendingAction && (
          <section
            className="pending-panel"
            aria-labelledby="pending-heading"
            ref={pendingRef}
            tabIndex="-1"
          >
            <p className="eyebrow">Needs confirmation</p>
            <h2 id="pending-heading">Review this action</h2>
            <p className="pending-summary">{pendingAction.humanSummary}</p>
            {pendingAction.details?.items?.map((item) => (
              <ProductCard key={item.name} item={item} />
            ))}
            {expiryWarning && <p className="warning" role="alert">{expiryWarning}</p>}
            <div className="pending-actions">
              <button type="button" className="confirm-button" onClick={() => handlePending('confirm')} disabled={isSending}>
                Confirm
              </button>
              <button type="button" className="cancel-button" onClick={() => handlePending('cancel')} disabled={isSending}>
                Cancel
              </button>
            </div>
            <p className="confirmation-help">You can also say “confirm” or “cancel”.</p>
          </section>
        )}
      </main>

      <footer className="help-footer">
        <h2>Keyboard shortcuts</h2>
        <p><kbd>Space</kbd> talk <span aria-hidden="true">·</span> <kbd>Escape</kbd> cancel <span aria-hidden="true">·</span> <kbd>R</kbd> repeat</p>
      </footer>
    </div>
  )
}

export default App

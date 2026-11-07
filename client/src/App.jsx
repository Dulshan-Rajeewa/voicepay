import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import en from './i18n/en'
import {
  approveAction,
  getDeviceStatus,
  isSupported as isWebAuthnSupported,
  registerDevice,
  removeDevice,
  practiceApproval,
  getPinStatus,
  setPin,
  changePin,
  approveWithPin,
  getWebAuthnConfig,
  isPlatformAuthenticatorAvailable,
  isInAppBrowser,
} from './services/webauthn'

const SESSION_STORAGE_KEY = 'voicepay-session-id'
const SPEECH_RATE_KEY = 'voicepay-speech-rate'
const SETTINGS_KEY = 'voicepay-settings'
const SETUP_KEY = 'voicepay-setup'
const WARNING_WINDOW_MS = 60 * 1000

const QUICK_ACTIONS = [
  ['balance', en.actions.balance],
  ['send', en.actions.send],
  ['shop', en.actions.shop],
  ['payments', en.actions.payments],
  ['people', en.actions.people],
  ['help', en.actions.help],
  ['repeat', en.actions.repeat],
]

const ICON_PATHS = {
  logo: 'M12 3.5a8.5 8.5 0 0 0-8.5 8.5c0 1.7.5 3.3 1.5 4.6L4 20.5l4.4-1.2A8.5 8.5 0 1 0 12 3.5Zm-3.2 8.8 2.1 2.1 4.4-4.4',
  wallet: 'M4 7.5h15a1 1 0 0 1 1 1v8.8a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 17.3V6.2A1.2 1.2 0 0 1 4.2 5H17m3 6h-4a2 2 0 0 0 0 4h4',
  send: 'm4 11 16-7-7 16-2.5-6.5L4 11Zm6.5 2.5L20 4',
  bag: 'M5 8h14l-1 12H6L5 8Zm3 0V6a4 4 0 0 1 8 0v2',
  receipt: 'M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8v-17Zm3 5h6m-6 3h6m-6 3h4',
  people: 'M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-5 8a5 5 0 0 1 10 0m3-8a3 3 0 1 0-1.5-5.6m1.5 7.1a4.5 4.5 0 0 1 3.5 4',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2.2-10.5a2.3 2.3 0 1 1 4.2 1.3c-.9 1.1-2 1.2-2 2.7m0 2.8h.01',
  mic: 'M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm-6-3a6 6 0 0 0 12 0m-6 6v3m-3 0h6',
  stop: 'M6 6h12v12H6z',
  speaker: 'M4 10v4h3l4 4V6l-4 4H4Zm11 1a3 3 0 0 1 0 2m2-4a6 6 0 0 1 0 6',
  check: 'm5 12 4 4L19 6',
  x: 'm6 6 12 12M18 6 6 18',
  warning: 'M12 4 21 20H3L12 4Zm0 5v5m0 3h.01',
  settings: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0-5v2m0 13v2m8.5-8.5h-2m-13 0h-2m13.5-5.5-1.4 1.4M7.4 16.1 6 17.5m11.5 0-1.4-1.4M7.4 7.4 6 6',
  copy: 'M8 8h10v12H8zM6 16H4V4h10v2',
}

function Icon({ name, size = 24, className = '' }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name] || ICON_PATHS.help} />
    </svg>
  )
}

const getGreeting = () => {
  const hour = new Date().getHours()
  return hour < 12 ? en.greeting.morning : hour < 18 ? en.greeting.afternoon : en.greeting.evening
}

const DEFAULT_SETTINGS = {
  textSize: 'normal',
  theme: 'light',
  voice: true,
  haptics: true,
  reduceMotion: 'auto',
  language: 'en',
}
const hearProduct = (text) => speak(text)

const getSessionId = () => {
  const saved = localStorage.getItem(SESSION_STORAGE_KEY)
  if (saved) return saved
  const id = crypto.randomUUID()
  localStorage.setItem(SESSION_STORAGE_KEY, id)
  return id
}

const readSettings = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    const theme = ['light', 'dark', 'auto', 'high-contrast'].includes(saved.theme) ? saved.theme : 'light'
    return { ...DEFAULT_SETTINGS, ...saved, theme }
  } catch {
    return { ...DEFAULT_SETTINGS, theme: 'light' }
  }
}

function getMicrophoneDeniedMessage() {
  const userAgent = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/i.test(userAgent)) return en.setup.microphoneDeniedGuidance.iphone
  if (/Android/i.test(userAgent)) return en.setup.microphoneDeniedGuidance.android
  return en.setup.microphoneDeniedGuidance.desktop
}

function StatusPill({ connectionStatus, onRetry }) {
  const labels = {
    connected: ['check', 'Connected'],
    connecting: ['help', en.waking],
    waking: ['help', en.waking],
    offline: ['warning', "Can't reach server"],
  }
  const [icon, label] = labels[connectionStatus] || labels.connecting
  return (
    <div className={`status-pill status-${connectionStatus}`} role="status" aria-live="polite">
      <Icon name={icon} size={18} />
      <span>{label}</span>
      {connectionStatus === 'offline' && (
        <button type="button" className="status-retry" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

function SettingsDrawer({
  settings,
  speechRate,
  onSettingsChange,
  onSpeechRateChange,
  onClose,
  speak,
  deviceStatus,
  deviceSupported,
  deviceBusy,
  onRegisterDevice,
  onRemoveDevice,
  onRunSetup,
  onFixMicrophone,
  onFixDevice,
  diagnostics,
  onCopyLink,
  pinStatus,
  onSetPin,
}) {
  const drawerRef = useRef(null)
  const update = (key, value) => onSettingsChange({ ...settings, [key]: value })

  useEffect(() => {
    drawerRef.current?.focus()
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const rateLabel = speechRate < 0.9 ? 'Slow' : speechRate > 1.1 ? 'Fast' : 'Normal speed'
  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <aside className="settings-drawer" aria-labelledby="settings-heading" tabIndex="-1" ref={drawerRef}>
        <div className="drawer-header">
          <div>
            <h2 id="settings-heading">Settings</h2>
          </div>
          <button type="button" className="icon-text-button" onClick={onClose}>Close settings</button>
        </div>

        <fieldset>
          <legend>{en.language}</legend>
          <select value={settings.language} onChange={(event) => update('language', event.target.value)} aria-label={en.language}>
            {en.languages.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
          </select>
        </fieldset>

        <fieldset>
          <legend>Text size</legend>
          <div className="choice-row">
            {['normal', 'large', 'extra-large'].map((value) => (
              <label key={value} className="choice">
                <input type="radio" name="text-size" checked={settings.textSize === value} onChange={() => update('textSize', value)} />
                <span>{value === 'extra-large' ? 'Extra large' : value[0].toUpperCase() + value.slice(1)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Theme</legend>
          <div className="choice-row">
            {['light', 'dark', 'auto', 'high-contrast'].map((value) => (
              <label key={value} className="choice">
                <input type="radio" name="theme" checked={settings.theme === value} onChange={() => update('theme', value)} />
                <span>{value === 'high-contrast' ? 'High contrast' : value[0].toUpperCase() + value.slice(1)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Speech</legend>
          <div className="rate-control">
            <button type="button" className="small-button" onClick={() => onSpeechRateChange(Math.max(0.6, speechRate - 0.1))} aria-label="Slow speech down">−</button>
            <input id="settings-speech-rate" type="range" min="0.6" max="1.5" step="0.1" value={speechRate} onChange={(event) => onSpeechRateChange(Number(event.target.value))} aria-describedby="settings-rate-value" />
            <button type="button" className="small-button" onClick={() => onSpeechRateChange(Math.min(1.5, speechRate + 0.1))} aria-label="Speed speech up">+</button>
            <output id="settings-rate-value">{rateLabel} ({speechRate.toFixed(1)}x)</output>
          </div>
          <label className="switch-row">
            <input type="checkbox" checked={settings.voice} onChange={(event) => update('voice', event.target.checked)} />
            <span>Read replies aloud</span>
          </label>
        </fieldset>

        <fieldset>
          <legend>Other preferences</legend>
          <label className="switch-row">
            <input type="checkbox" checked={settings.haptics} onChange={(event) => update('haptics', event.target.checked)} />
            <span>Use haptic feedback when available</span>
          </label>
          <div className="choice-row">
            {['auto', 'on'].map((value) => (
              <label key={value} className="choice">
                <input type="radio" name="reduce-motion" checked={settings.reduceMotion === value} onChange={() => update('reduceMotion', value)} />
                <span>Reduce motion: {value === 'auto' ? 'Auto' : 'On'}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Secure confirmation</legend>
          <p className="device-status">
            {deviceStatus?.registered ? 'This device is set up.' : 'This device is not set up yet.'}
          </p>
          <div className="device-actions">
            <button type="button" className="secondary-button" onClick={onRegisterDevice} disabled={deviceBusy || !deviceSupported}>
              {deviceBusy ? 'Setting up...' : 'Set up this device'}
            </button>
            <button type="button" className="cancel-button" onClick={onRemoveDevice} disabled={deviceBusy || !deviceStatus?.registered}>
              Remove this device
            </button>
          </div>
          {pinStatus?.allowed && <div className="device-actions">
            <p className="device-status">{pinStatus.configured ? en.pin.setUp : en.pin.notSet}</p>
            <button type="button" className="secondary-button" onClick={onSetPin}>{pinStatus.configured ? en.pin.change : en.pin.set}</button>
          </div>}
          <div className="device-actions">
            <button type="button" className="secondary-button" onClick={onFixDevice} disabled={deviceBusy}>Fix device check</button>
          </div>
          {!deviceSupported && <p className="device-help">This browser does not support device checks. Try a recent Chrome, Safari, or Edge browser.</p>}
          <details className="troubleshoot">
            <summary>Troubleshoot</summary>
            <div className="troubleshoot-copy">
              <p>Secure context: {String(diagnostics.secureContext)}</p>
              <p>Page address: {diagnostics.origin || 'unknown'}</p>
              <p>Server RP ID: {diagnostics.rpId || 'unknown'}</p>
              <p>Server origins: {diagnostics.expectedOrigins?.join(', ') || 'unknown'}</p>
              <p>Device check support: {String(diagnostics.supported)}</p>
              <p>Platform check available: {String(diagnostics.platformAvailable)}</p>
              <p>In-app browser: {String(diagnostics.inAppBrowser)}</p>
              {diagnostics.inAppBrowser && <p className="device-help">Please open this page in Chrome or Safari.</p>}
              <p>Last error: {diagnostics.lastError ? `${diagnostics.lastError.name}: ${diagnostics.lastError.message}` : 'none'}</p>
              {diagnostics.lastFix && <p>{diagnostics.lastFix}</p>}
            </div>
            {diagnostics.inAppBrowser && <button type="button" className="secondary-button" onClick={onCopyLink}>Copy link</button>}
          </details>
        </fieldset>

        <fieldset>
          <legend>VoicePay setup</legend>
          <div className="device-actions">
            <button type="button" className="secondary-button" onClick={onFixMicrophone}>Fix microphone</button>
            <button type="button" className="secondary-button" onClick={onRunSetup}>Run setup again</button>
          </div>
        </fieldset>

        <p className="preview-line" aria-live="polite">
          Preview: {settings.voice ? 'replies will be read aloud' : 'replies will stay on screen'} at {rateLabel.toLowerCase()}.
        </p>
        <section className="help-section" aria-labelledby="commands-heading">
          <h3 id="commands-heading">Keyboard shortcuts and voice commands</h3>
          <p>Press and hold Space to talk. Press Escape to cancel a pending action. Press R to repeat the last answer. You can also say repeat, confirm, or cancel.</p>
        </section>
        <button type="button" className="primary-button full-width" onClick={() => speak('Settings saved.')}>Hear settings confirmation</button>
      </aside>
    </div>
  )
}

function SetupDialog({
  step,
  micStatus,
  deviceSupported,
  deviceStatus,
  busy,
  onContinue,
  onDeviceSetup,
  onPractice,
  onSkip,
  onBack,
  onRepeat,
  onFinish,
  onUseTyping,
  pinAvailable,
  onPinSetup,
}) {
  const headingRef = useRef(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [step])

  const stepTitle = step === 1
    ? en.setup.welcomeTitle
    : step === 2
      ? en.setup.microphoneTitle
      : step === 3
        ? en.setup.deviceTitle
        : en.setup.practiceTitle
  const stepText = step === 1
    ? en.setup.welcome
    : step === 2
      ? micStatus === 'granted'
        ? en.setup.microphoneReady
        : micStatus === 'denied'
          ? `${en.setup.microphoneDenied} ${getMicrophoneDeniedMessage()}`
          : en.setup.microphonePermission
      : step === 3
        ? deviceSupported
          ? en.setup.deviceIntro
          : en.setup.deviceUnsupported
        : en.setup.practiceIntro

  return (
    <div className="setup-layer" role="presentation">
      <section className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-heading" aria-describedby="setup-copy">
        <p className="setup-progress">{en.setup.stepLabel(step)}</p>
        <h2 id="setup-heading" ref={headingRef} tabIndex="-1">{stepTitle}</h2>
        <p id="setup-copy">{stepText}</p>
        {step === 2 && micStatus === 'prompt' && <p className="setup-note">{en.setup.microphoneIntro}</p>}
        {step === 2 && ['denied', 'unsupported'].includes(micStatus) && <button type="button" className="secondary-button full-width" onClick={onUseTyping}>{en.setup.useTyping}</button>}
        {step === 3 && !deviceSupported && <p className="setup-note">{en.setup.useTyping}</p>}
        {step === 4 && <p className="setup-note">{en.setup.practicePrompt}</p>}

        <div className="setup-actions">
          {step === 1 && <button type="button" className="primary-button full-width" onClick={onContinue}>{en.setup.continue}</button>}
          {step === 2 && micStatus !== 'granted' && <button type="button" className="primary-button full-width" onClick={onContinue} disabled={busy}>{en.setup.continue}</button>}
          {step === 2 && micStatus === 'granted' && <button type="button" className="primary-button full-width" onClick={onContinue}>{en.setup.continue}</button>}
          {step === 3 && !deviceStatus?.registered && <button type="button" className="primary-button full-width" onClick={onDeviceSetup} disabled={busy || !deviceSupported}>{busy ? 'Setting up...' : en.setup.setUpNow}</button>}
          {step === 3 && pinAvailable && !deviceSupported && <button type="button" className="secondary-button full-width" onClick={onPinSetup}>{en.pin.set}</button>}
          {step === 3 && deviceStatus?.registered && <button type="button" className="primary-button full-width" onClick={onContinue}>{en.setup.continue}</button>}
          {step === 4 && <button type="button" className="primary-button full-width" onClick={onPractice} disabled={busy || !deviceStatus?.registered}>{busy ? 'Checking...' : en.setup.practice}</button>}
          {step === 4 && deviceStatus?.registered && <button type="button" className="secondary-button full-width" onClick={onFinish}>{en.setup.done}</button>}
        </div>

        <div className="setup-navigation">
          <button type="button" className="text-button" onClick={onRepeat}>{en.setup.repeat}</button>
          {step > 1 && <button type="button" className="text-button" onClick={onBack}>{en.setup.back}</button>}
          {step < 4 && <button type="button" className="text-button" onClick={onSkip}>{en.setup.skip}</button>}
          {step === 4 && <button type="button" className="text-button" onClick={onSkip}>{en.setup.skip}</button>}
        </div>
      </section>
    </div>
  )
}

function ProductCard({ item, onHear, onBuy }) {
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
  const description = details.map(([label, value]) => `${label}: ${value}`).join(' ')
  return (
    <article className="product-card" aria-label={`Product: ${item.name}`}>
      <div className="product-placeholder" role="img" aria-label={`Text-only product placeholder for ${item.name}`}>
        <Icon name="bag" size={32} />
        <span>Product details in text</span>
      </div>
      <h3>{item.name}</h3>
      <p className="product-price">${Number(item.unitAmount || item.price || 0).toFixed(2)}</p>
      <p>{item.description || 'Product details are available in the full text description.'}</p>
      <details>
        <summary>Full product description</summary>
        <p>{description}</p>
      </details>
      <div className="product-actions">
        <button type="button" className="secondary-button" onClick={() => onHear(description)}>Hear details</button>
        <button type="button" className="primary-button" onClick={() => onBuy?.(`Buy one ${item.name}`)}>Buy this</button>
      </div>
    </article>
  )
}

function ActionTile({ action, onClick }) {
  const [name, details] = action
  return (
    <button type="button" className={`action-tile action-${name}`} onClick={onClick} aria-label={details.label}>
      <span className="action-icon"><Icon name={name === 'balance' ? 'wallet' : name === 'send' ? 'send' : name === 'shop' ? 'bag' : name === 'payments' ? 'receipt' : name === 'people' ? 'people' : 'help'} size={34} /></span>
      <span>{details.label}</span>
    </button>
  )
}

function MessageBubble({ entry, onRepeat, onCopy }) {
  const isUser = entry.kind === 'user'
  return (
    <li className={`message message-${entry.kind}`}>
      <div className="message-meta">
        <span className="message-label">{isUser ? 'You' : 'VoicePay'}</span>
        <time dateTime={entry.createdAt}>{entry.time}</time>
      </div>
      <p>{entry.text}</p>
      {!isUser && (
        <div className="message-actions">
          <button type="button" className="text-button" onClick={() => onRepeat(entry.text)}><Icon name="speaker" size={18} />{en.listenAgain}</button>
          <button type="button" className="text-button" onClick={() => onCopy(entry.text)}><Icon name="copy" size={18} />{en.copy}</button>
        </div>
      )}
    </li>
  )
}

function PendingActionCard({
  pendingAction,
  expiryText,
  onConfirm,
  onCancel,
  pendingRef,
  isSending,
  isDialog,
  onHear,
  onBuy,
  deviceApprovalStep,
  onDeviceApprove,
  deviceError,
  onPinApprove,
  pinAvailable,
  deviceSupported,
}) {
  const amount = pendingAction.details?.amount || pendingAction.details?.total
  const items = pendingAction.details?.items
  const isPurchase = pendingAction.type === 'purchase'
  const contactName = pendingAction.details?.contactName || pendingAction.details?.name
  const initials = contactName ? contactName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() : null
  return (
    <section
      className={`pending-panel pending-${isPurchase ? 'shop' : 'send'} ${isDialog ? 'pending-dialog' : ''}`}
      aria-labelledby="pending-heading"
      ref={pendingRef}
      tabIndex="-1"
      role={isDialog ? 'dialog' : undefined}
      aria-modal={isDialog ? 'true' : undefined}
    >
      <div className="pending-heading-row"><Icon name={isPurchase ? 'bag' : 'send'} size={28} /><h2 id="pending-heading">{isPurchase ? 'You are buying' : 'You are sending'}</h2></div>
      {amount && <p className="big-amount"><strong>${Number(amount).toFixed(2)}</strong><span>{Number(amount).toFixed(2)} dollars</span></p>}
      {initials && <p className="contact-chip"><span className="contact-avatar" aria-hidden="true">{initials}</span><strong>{contactName}</strong></p>}
      <p className="pending-summary">{pendingAction.humanSummary}</p>
      {items?.map((item) => <ProductCard key={item.name} item={item} onHear={onHear} onBuy={onBuy} />)}
      <p className="expiry-line"><span aria-hidden="true">◷</span> {expiryText}</p>
      {deviceApprovalStep === 'ready' ? (
        <div className="device-check-step">
          <p>Now press the big button to check it is you. Your device may ask for your fingerprint, face, or PIN.</p>
          {deviceError && <p className="device-error" role="alert">{deviceError}</p>}
          <button type="button" className="device-check-button" onClick={onDeviceApprove} disabled={isSending} autoFocus>
            <Icon name="check" size={28} />Check it&apos;s you
          </button>
          {pinAvailable && (!deviceSupported || deviceError) && <button type="button" className="secondary-button full-width" onClick={onPinApprove} disabled={isSending}>{en.pin.fallback}</button>}
          <button type="button" className="cancel-button" onClick={onCancel} disabled={isSending}><Icon name="x" size={22} />{en.cancel}</button>
        </div>
      ) : (
        <div className="pending-actions">
          <button type="button" className="confirm-button" onClick={onConfirm} disabled={isSending}><Icon name="check" size={22} />{isPurchase ? 'Yes, buy it' : en.confirm}</button>
          <button type="button" className="cancel-button" onClick={onCancel} disabled={isSending}><Icon name="x" size={22} />{en.cancel}</button>
        </div>
      )}
      <p className="confirmation-help">You can also say “confirm” or “cancel”. Press Escape to cancel.</p>
    </section>
  )
}

function PinDialog({ mode, value, currentValue, onValueChange, onCurrentChange, onDone, onCancel }) {
  const title = mode === 'approve' ? 'Enter your VoicePay PIN' : mode === 'change' ? 'Change your VoicePay PIN' : 'Set up your VoicePay PIN'
  const addDigit = (digit) => {
    if (value.length < 6) onValueChange(`${value}${digit}`)
  }
  const removeDigit = () => onValueChange(value.slice(0, -1))
  return (
    <div className="setup-layer" role="presentation">
      <section className="pin-dialog" role="dialog" aria-modal="true" aria-labelledby="pin-heading">
        <h2 id="pin-heading" tabIndex="-1">{title}</h2>
        <p>{en.pin.warning}</p>
        <p>{en.pin.noVoice}</p>
        {mode === 'change' && <label className="pin-label">Current PIN
          <input type="password" inputMode="numeric" autoComplete="current-password" maxLength="6" value={currentValue} onChange={(event) => onCurrentChange(event.target.value.replace(/\D/g, '').slice(0, 6))} />
        </label>}
        <label className="pin-label">Six digit PIN
          <input type="password" inputMode="numeric" autoComplete={mode === 'set' ? 'new-password' : 'current-password'} maxLength="6" value={value} onChange={(event) => onValueChange(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-describedby="pin-status" />
        </label>
        <p id="pin-status" aria-live="polite">{en.pin.digit(value.length)}</p>
        <div className="pin-pad" aria-label="PIN number pad">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => <button type="button" key={digit} onClick={() => addDigit(String(digit))} aria-label={`Enter digit ${digit}`}>{digit}</button>)}
          <button type="button" onClick={removeDigit} aria-label={en.pin.delete}>{en.pin.delete}</button>
          <button type="button" onClick={() => addDigit('0')} aria-label="Enter digit 0">0</button>
          <button type="button" onClick={onDone} aria-label={en.pin.done}>{en.pin.done}</button>
        </div>
        <button type="button" className="cancel-button" onClick={onCancel}>{en.cancel}</button>
      </section>
    </div>
  )
}

function App() {
  const [messages, setMessages] = useState([])
  const [message, setMessage] = useState('')
  const [pendingAction, setPendingAction] = useState(null)
  const [isListening, setIsListening] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [speechRate, setSpeechRate] = useState(() => Number(localStorage.getItem(SPEECH_RATE_KEY) || '1'))
  const [settings, setSettings] = useState(readSettings)
  const [connectionStatus, setConnectionStatus] = useState('connecting')
  const [requestStatus, setRequestStatus] = useState('Ready')
  const [expiryWarning, setExpiryWarning] = useState('')
  const [lastSpoken, setLastSpoken] = useState('')
  const [caption, setCaption] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [resultBanner, setResultBanner] = useState(null)
  const [deviceStatus, setDeviceStatus] = useState({ registered: false, required: true })
  const [deviceSupported, setDeviceSupported] = useState(false)
  const [deviceBusy, setDeviceBusy] = useState(false)
  const [deviceApprovalStep, setDeviceApprovalStep] = useState(null)
  const [deviceError, setDeviceError] = useState('')
  const [pinStatus, setPinStatus] = useState({ configured: false, allowed: true })
  const [pinDialog, setPinDialog] = useState(null)
  const [pinValue, setPinValue] = useState('')
  const [pinCurrent, setPinCurrent] = useState('')
  const [webauthnDiagnostics, setWebauthnDiagnostics] = useState({
    secureContext: window.isSecureContext,
    origin: window.location.origin,
    rpId: '',
    expectedOrigins: [],
    supported: false,
    platformAvailable: false,
    inAppBrowser: isInAppBrowser(),
    lastError: null,
    lastFix: '',
  })
  const [setupOpen, setSetupOpen] = useState(() => localStorage.getItem(SETUP_KEY) !== 'done')
  const [setupStep, setSetupStep] = useState(() => localStorage.getItem(SETUP_KEY) === 'done' ? 1 : 1)
  const [micStatus, setMicStatus] = useState(() => localStorage.getItem('voicepay-mic-status') || 'prompt')
  const [setupBusy, setSetupBusy] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia?.('(max-width: 899px)').matches ?? false)
  const recognitionRef = useRef(null)
  const isListeningRef = useRef(false)
  const stoppingRecognitionRef = useRef(false)
  const shortcutPressedRef = useRef(false)
  const ignoreClickRef = useRef(false)
  const pendingRef = useRef(null)
  const lastFocusedRef = useRef(null)
  const wakeAnnouncedRef = useRef(false)
  const conversationRef = useRef(null)
  const sessionIdRef = useRef(getSessionId())

  const vibrate = useCallback((pattern) => {
    if (settings.haptics && 'vibrate' in navigator) navigator.vibrate(pattern)
  }, [settings.haptics])

  const speak = useCallback((text) => {
    if (!text) return
    setCaption(text)
    setLastSpoken(text)
    if (!settings.voice || !('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = speechRate
    utterance.onstart = () => setIsSpeaking(true)
    utterance.onend = () => setIsSpeaking(false)
    utterance.onerror = () => setIsSpeaking(false)
    window.speechSynthesis.speak(utterance)
  }, [settings.voice, speechRate])

  const addMessage = useCallback((text, kind = 'assistant') => {
    const now = new Date()
    setMessages((current) => [...current, {
      id: crypto.randomUUID(),
      kind,
      text,
      createdAt: now.toISOString(),
      time: now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    }])
  }, [])

  const announce = useCallback((text, kind = 'assistant') => {
    addMessage(text, kind)
    speak(text)
  }, [addMessage, speak])

  const checkHealth = useCallback(async () => {
    setConnectionStatus('waking')
    if (!wakeAnnouncedRef.current) {
      wakeAnnouncedRef.current = true
      speak(en.waking)
    }
    try {
      const response = await fetch('/api/health', { cache: 'no-store' })
      if (!response.ok) throw new Error('Health check failed')
      setConnectionStatus('connected')
      if (wakeAnnouncedRef.current) speak(en.serverReady)
    } catch {
      setConnectionStatus('offline')
    }
  }, [speak])

  useEffect(() => {
    const timer = window.setTimeout(checkHealth, 0)
    return () => window.clearTimeout(timer)
  }, [checkHealth])

  useEffect(() => {
    if (connectionStatus !== 'offline') return undefined
    const timer = window.setInterval(checkHealth, 5000)
    return () => window.clearInterval(timer)
  }, [connectionStatus, checkHealth])

  const refreshDeviceStatus = useCallback(async () => {
    try {
      const [status, supported, platformAvailable, webAuthnConfig, pin] = await Promise.all([
        getDeviceStatus(),
        isWebAuthnSupported(),
        isPlatformAuthenticatorAvailable(),
        getWebAuthnConfig(),
        getPinStatus(),
      ])
      setDeviceStatus(status)
      localStorage.setItem('voicepay-device-registered', status.registered ? 'true' : 'false')
      setDeviceSupported(supported)
      setPinStatus(pin)
      setWebauthnDiagnostics((current) => ({
        ...current,
        supported,
        platformAvailable,
        rpId: webAuthnConfig.rpId,
        expectedOrigins: webAuthnConfig.expectedOrigins,
        origin: webAuthnConfig.currentOrigin || current.origin,
      }))
    } catch (error) {
      setDeviceSupported(false)
      setWebauthnDiagnostics((current) => ({
        ...current,
        lastError: { name: error.name || 'Error', message: error.message || 'Could not load device-check settings.' },
        lastFix: 'Refresh VoicePay and open it at the stable production address.',
      }))
    }
  }, [])

  useEffect(() => {
    refreshDeviceStatus()
  }, [refreshDeviceStatus])

  useEffect(() => {
    let active = true
    const checkMicrophone = async () => {
      if (!navigator.permissions?.query) return
      try {
        const permission = await navigator.permissions.query({ name: 'microphone' })
        if (active && permission.state !== 'prompt') {
          setMicStatus(permission.state)
          localStorage.setItem('voicepay-mic-status', permission.state)
        }
      } catch {
        // Some browsers do not expose microphone permission state.
      }
    }
    checkMicrophone()
    return () => { active = false }
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 899px)')
    const updateViewport = () => setIsMobile(mediaQuery.matches)
    mediaQuery.addEventListener?.('change', updateViewport)
    return () => mediaQuery.removeEventListener?.('change', updateViewport)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.dataset.textSize = settings.textSize
    document.documentElement.dataset.reduceMotion = settings.reduceMotion
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  const setupMessage = useCallback((text) => {
    speak(text)
    vibrate([60])
  }, [speak, vibrate])

  const initialSetupAnnouncedRef = useRef(false)
  useEffect(() => {
    if (setupOpen && !initialSetupAnnouncedRef.current) {
      initialSetupAnnouncedRef.current = true
      setupMessage(en.setup.welcome)
    }
  }, [setupMessage, setupOpen])

  const beginSetup = useCallback((step = 1) => {
    setSetupStep(step)
    setSetupOpen(true)
    setupMessage(step === 1 ? en.setup.welcome : step === 2 ? en.setup.microphonePermission : step === 3 ? en.setup.deviceIntro : en.setup.practiceIntro)
  }, [setupMessage])

  const finishSetup = useCallback((message = en.setup.practiceDone) => {
    localStorage.setItem(SETUP_KEY, 'done')
    setSetupOpen(false)
    setupMessage(message)
  }, [setupMessage])

  const skipSetup = useCallback(() => {
    finishSetup(en.setup.skipped)
  }, [finishSetup])

  const requestMicrophone = useCallback(async () => {
    setSetupBusy(true)
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicStatus('unsupported')
        localStorage.setItem('voicepay-mic-status', 'unsupported')
        setupMessage(en.setup.microphoneUnsupported)
        return 'unsupported'
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      setMicStatus('granted')
      localStorage.setItem('voicepay-mic-status', 'granted')
      setupMessage(en.setup.microphoneReady)
      return 'granted'
    } catch (error) {
      const status = error.name === 'NotAllowedError' ? 'denied' : 'prompt'
      setMicStatus(status)
      localStorage.setItem('voicepay-mic-status', status)
      setupMessage(`${en.setup.microphoneDenied} ${getMicrophoneDeniedMessage()}`)
      return status
    } finally {
      setSetupBusy(false)
    }
  }, [setupMessage])

  const continueSetup = useCallback(async () => {
    if (setupStep === 1) {
      setSetupStep(2)
      setupMessage(en.setup.microphonePermission)
      return
    }
    if (setupStep === 2) {
      const status = micStatus === 'granted' ? 'granted' : await requestMicrophone()
      if (status === 'granted' || status === 'unsupported' || status === 'denied') {
        setSetupStep(3)
        setupMessage(en.setup.deviceIntro)
      }
      return
    }
    if (setupStep === 3 && deviceStatus?.registered) {
      setSetupStep(4)
      setupMessage(en.setup.practiceIntro)
    }
  }, [deviceStatus.registered, micStatus, requestMicrophone, setupMessage, setupStep])

  const useTypingInstead = useCallback(() => {
    setMicStatus('skipped')
    localStorage.setItem('voicepay-mic-status', 'skipped')
    setSetupStep(3)
    setupMessage(en.setup.deviceIntro)
  }, [setupMessage])

  const guidedDeviceSetup = useCallback(async () => {
    if (webauthnDiagnostics.inAppBrowser) {
      setupMessage('Please open this page in Chrome or Safari, then press Set up now again.')
      return
    }
    if (deviceBusy || !deviceSupported) {
      setupMessage(en.setup.deviceUnsupported)
      return
    }
    setSetupBusy(true)
    try {
      await registerDevice()
      await refreshDeviceStatus()
      localStorage.setItem('voicepay-device-registered', 'true')
      setupMessage(`${en.setup.deviceReady} ${en.setup.practiceIntro}`)
      setSetupStep(4)
    } catch (error) {
      setDeviceSupported(false)
      const text = error.name === 'NotAllowedError' ? en.setup.deviceCancelled : `This device could not be set up. ${error.message || 'Please try again.'}`
      setupMessage(text)
    } finally {
      setSetupBusy(false)
    }
  }, [deviceBusy, deviceSupported, refreshDeviceStatus, setupMessage, webauthnDiagnostics.inAppBrowser])

  const practiceSetup = useCallback(async () => {
    setSetupBusy(true)
    try {
      await practiceApproval()
      setupMessage(en.setup.practiceDone)
      finishSetup()
    } catch (error) {
      setupMessage(error.name === 'NotAllowedError' ? en.setup.practiceCancelled : `${en.setup.practiceError} ${error.message || ''}`.trim())
    } finally {
      setSetupBusy(false)
    }
  }, [finishSetup, setupMessage])

  const sendMessage = useCallback(async (text) => {
    const trimmed = text.trim()
    if (!trimmed || isSending) return
    setMessage('')
    setIsSending(true)
    setIsThinking(true)
    setRequestStatus('Sending')
    addMessage(trimmed, 'user')
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionIdRef.current },
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
        lastFocusedRef.current = document.activeElement
        vibrate([120, 80, 120])
        if (deviceStatus.required && !deviceStatus.registered) {
          beginSetup(3)
        }
      }
      setConnectionStatus('connected')
      setRequestStatus('Ready')
    } catch (error) {
      announce(`Sorry. ${error.message || 'Something went wrong. Please try again.'}`, 'error')
      vibrate([80, 60, 80])
      setRequestStatus('Error')
      setConnectionStatus('offline')
    } finally {
      setIsThinking(false)
      setIsSending(false)
    }
  }, [addMessage, announce, beginSetup, deviceStatus.registered, deviceStatus.required, isSending, vibrate])

  const executeConfirmedAction = useCallback(async () => {
    if (!pendingAction || isSending) return
    setIsSending(true)
    setRequestStatus('Confirming')
    try {
      const response = await fetch('/api/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionIdRef.current },
        body: JSON.stringify({ actionId: pendingAction.id, confirmation: true }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'The action could not be completed.')
      setPendingAction(null)
      setExpiryWarning('')
      setDeviceApprovalStep(null)
      setDeviceError('')
      const actionAmount = pendingAction.details?.amount || pendingAction.details?.total
      const actionName = pendingAction.details?.contactName || pendingAction.details?.name
      const resultText = data.action?.result?.status === 'SUCCESS' || data.action?.result?.status === 'COMPLETED'
        ? pendingAction.type === 'purchase'
          ? 'Done! Your purchase is complete.'
          : `Done! ${actionAmount ? `${Number(actionAmount).toFixed(2)} dollars` : 'Your payment'}${actionName ? ` sent to ${actionName}` : ' sent'}.`
        : data.action?.result?.status === 'PENDING'
          ? 'PayPal accepted your payment. It is still processing, and no further approval is needed right now.'
          : data.action?.result?.message || 'Your action needs more PayPal approval.'
      setResultBanner({ kind: 'success', text: resultText })
      announce(resultText)
      vibrate([180, 80, 180])
      setRequestStatus('Ready')
      window.setTimeout(() => lastFocusedRef.current?.focus?.(), 0)
    } catch (error) {
      const text = `Sorry. ${error.message || 'That action could not be completed.'}`
      setResultBanner({ kind: 'error', text })
      announce(text, 'error')
      vibrate([80, 60, 80])
      setRequestStatus('Error')
    } finally {
      setIsSending(false)
    }
  }, [announce, isSending, pendingAction, vibrate])

  const handleDeviceApprove = useCallback(async () => {
    if (!pendingAction || isSending) return
    setDeviceBusy(true)
    setIsSending(true)
    setDeviceError('')
    setRequestStatus("Checking it's you")
    try {
      await approveAction(pendingAction.id, sessionIdRef.current)
      setDeviceApprovalStep('approved')
      await executeConfirmedAction()
    } catch (error) {
      const actionMissing = error.message === 'Pending action was not found.'
      const text = error.name === 'NotAllowedError'
        ? 'The device check was cancelled or timed out. Nothing was sent. Press Check it’s you to try again.'
        : actionMissing
          ? 'This payment is no longer available after the server restarted. Nothing was sent. Please submit the payment request again.'
        : error.code === 'DEVICE_NOT_REGISTERED'
          ? 'This device is not set up yet. Open Settings and choose Set up this device.'
          : `The device check did not work. ${error.message || 'Please try again.'}`
      if (actionMissing) {
        setPendingAction(null)
        setDeviceApprovalStep(null)
      }
      setDeviceError(text)
      setDeviceApprovalStep('ready')
      setResultBanner({ kind: 'error', text })
      announce(text, 'error')
      vibrate([80, 60, 80])
      setRequestStatus('Error')
      setIsSending(false)
    } finally {
      setDeviceBusy(false)
    }
  }, [announce, executeConfirmedAction, isSending, pendingAction, vibrate])

  const handlePending = useCallback(async (decision) => {
    if (!pendingAction || isSending) return
    if (decision === 'confirm' && deviceStatus.required) {
      setDeviceError('')
      setDeviceApprovalStep('ready')
      setRequestStatus("Needs device check")
      announce('Now press the big button, or the Space bar, to check it is you. Your phone will ask for your fingerprint, face, or PIN.')
      vibrate([120, 80, 120])
      return
    }

    if (decision === 'confirm') {
      await executeConfirmedAction()
      return
    }

    setIsSending(true)
    setRequestStatus('Cancelling')
    try {
      const response = await fetch('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionIdRef.current },
        body: JSON.stringify({ actionId: pendingAction.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'The action could not be cancelled.')
      setPendingAction(null)
      setDeviceApprovalStep(null)
      setExpiryWarning('')
      const resultText = 'Okay. Nothing was sent.'
      setResultBanner({ kind: 'info', text: resultText })
      announce(resultText)
      vibrate([60])
      setRequestStatus('Ready')
      window.setTimeout(() => lastFocusedRef.current?.focus?.(), 0)
    } catch (error) {
      const text = `Sorry. ${error.message || 'That action could not be cancelled.'}`
      setResultBanner({ kind: 'error', text })
      announce(text, 'error')
      vibrate([80, 60, 80])
      setRequestStatus('Error')
    } finally {
      setIsSending(false)
    }
  }, [announce, deviceStatus.required, executeConfirmedAction, isSending, pendingAction, vibrate])

  const finishListening = useCallback(() => {
    stoppingRecognitionRef.current = true
    recognitionRef.current?.stop()
    isListeningRef.current = false
    setIsListening(false)
  }, [])

  const startListening = useCallback(() => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
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
      setRequestStatus('Listening')
      vibrate([80, 60, 80])
    }
    recognition.onresult = (event) => {
      stoppingRecognitionRef.current = false
      const transcript = event.results[0][0].transcript
      const command = transcript.trim().toLowerCase()
      if (setupOpen && ['repeat', 'skip', 'back'].includes(command)) {
        if (command === 'repeat') setupMessage(setupStep === 1 ? en.setup.welcome : setupStep === 2 ? en.setup.microphonePermission : setupStep === 3 ? en.setup.deviceIntro : en.setup.practiceIntro)
        if (command === 'skip') skipSetup()
        if (command === 'back' && setupStep > 1) setSetupStep((current) => current - 1)
        return
      }
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
      if (stoppingRecognitionRef.current || event.error === 'aborted') return
      isListeningRef.current = false
      setIsListening(false)
      setRequestStatus('Error')
      announce('I could not hear that. Please try again or type your message.', 'error')
      vibrate([80, 60, 80])
    }
    recognition.onend = () => {
      stoppingRecognitionRef.current = false
      isListeningRef.current = false
      setIsListening(false)
      setRequestStatus((current) => (current === 'Listening' ? 'Ready' : current))
    }
    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch (error) {
      setRequestStatus('Error')
      announce(error.message || 'Voice input could not be started. Please try again.', 'error')
    }
  }, [announce, handlePending, lastSpoken, pendingAction, sendMessage, setupMessage, setupOpen, setupStep, skipSetup, speak, vibrate])

  const handleSpeakClick = useCallback(() => {
    if (ignoreClickRef.current) {
      ignoreClickRef.current = false
      return
    }
    if (isListeningRef.current) finishListening()
    else startListening()
  }, [finishListening, startListening])

  const handleSpeakPointerDown = useCallback((event) => {
    event.preventDefault()
    ignoreClickRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    startListening()
  }, [startListening])

  const handleSpeakPointerUp = useCallback((event) => {
    event.preventDefault()
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    finishListening()
  }, [finishListening])

  const handleSpeakKeyDown = useCallback((event) => {
    if (event.code === 'Space') {
      event.preventDefault()
      if (!event.repeat) startListening()
    }
  }, [startListening])

  const handleSpeakKeyUp = useCallback((event) => {
    if (event.code === 'Space') {
      event.preventDefault()
      finishListening()
    }
  }, [finishListening])

  useEffect(() => {
    const handleKeyDown = (event) => {
      const target = event.target
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      if (setupOpen && !typing) {
        if (event.key.toLowerCase() === 'r') {
          event.preventDefault()
          setupMessage(setupStep === 1 ? en.setup.welcome : setupStep === 2 ? en.setup.microphonePermission : setupStep === 3 ? en.setup.deviceIntro : en.setup.practiceIntro)
        } else if (event.key.toLowerCase() === 's') {
          event.preventDefault()
          skipSetup()
        } else if (event.key.toLowerCase() === 'b' && setupStep > 1) {
          event.preventDefault()
          setSetupStep((current) => current - 1)
        }
        return
      }
      if (event.key === 'Escape' && pendingAction) {
        event.preventDefault()
        handlePending('cancel')
      } else if (event.key.toLowerCase() === 'r' && !typing) {
        event.preventDefault()
        speak(lastSpoken || 'There is no previous answer to repeat.')
      } else if (event.code === 'Space' && !typing && !(target instanceof HTMLButtonElement) && !event.repeat) {
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
  }, [finishListening, handlePending, lastSpoken, pendingAction, setupMessage, setupOpen, setupStep, skipSetup, speak, startListening])

  useEffect(() => {
    if (!pendingAction) return undefined
    pendingRef.current?.focus()
    window.setTimeout(() => speak(pendingAction.humanSummary), 0)
    return undefined
  }, [pendingAction, speak])

  useEffect(() => {
    if (!pendingAction || !isMobile) return undefined
    const dialog = pendingRef.current
    const focusable = () => [...dialog.querySelectorAll('button, input, summary, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.disabled)
    const trapFocus = (event) => {
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (!elements.length) return
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', trapFocus)
    return () => document.removeEventListener('keydown', trapFocus)
  }, [isMobile, pendingAction])

  useEffect(() => {
    if (!pendingAction) return undefined
    const checkExpiry = () => {
      const remaining = new Date(pendingAction.expiresAt).getTime() - Date.now()
      const seconds = Math.max(0, Math.ceil(remaining / 1000))
      const minutes = Math.floor(seconds / 60)
      const expiryText = remaining <= 0
        ? 'This pending action has expired.'
        : `Expires in ${minutes}:${String(seconds % 60).padStart(2, '0')}`
      setExpiryWarning(expiryText)
      if (remaining <= 0 && expiryWarning !== 'This pending action has expired.') {
        speak('This pending action has expired. It can no longer be confirmed.')
      } else if (remaining <= WARNING_WINDOW_MS && remaining > 0 && !expiryWarning.includes('expires in less than')) {
        speak('Warning. This action expires in less than one minute.')
      }
    }
    checkExpiry()
    const interval = window.setInterval(checkExpiry, 5000)
    return () => window.clearInterval(interval)
  }, [pendingAction, speak, expiryWarning])

  useEffect(() => {
    conversationRef.current?.scrollTo({ top: conversationRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!showSettings) return undefined
    const drawer = document.querySelector('.settings-drawer')
    const focusable = () => [...drawer.querySelectorAll('button, input, summary, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.disabled)
    const trapFocus = (event) => {
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (!elements.length) return
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', trapFocus)
    return () => document.removeEventListener('keydown', trapFocus)
  }, [showSettings])

  useEffect(() => {
    if (!setupOpen) return undefined
    const dialog = document.querySelector('.setup-dialog')
    const focusable = () => [...dialog.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.disabled)
    const trapFocus = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        skipSetup()
        return
      }
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (!elements.length) return
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', trapFocus)
    return () => document.removeEventListener('keydown', trapFocus)
  }, [setupOpen, skipSetup])

  const updateSpeechRate = (value) => {
    setSpeechRate(value)
    localStorage.setItem(SPEECH_RATE_KEY, String(value))
  }
  const updateSettings = (value) => setSettings(value)
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      announce('The answer was copied.')
    } catch {
      announce('I could not copy that answer. You can select the text manually.', 'error')
    }
  }
  const handleQuickAction = (value) => {
    if (value === 'repeat') speak(lastSpoken || 'There is no previous answer to repeat.')
    else sendMessage(value)
  }

  const announcePinDigit = useCallback((value) => {
    if (value.length < 6) {
      announce(en.pin.digit(value.length))
      vibrate(12)
    }
  }, [announce, vibrate])

  const submitPin = useCallback(async () => {
    if (pinValue.length !== 6) {
      announce('Enter all six digits first.', 'error')
      return
    }
    setDeviceBusy(true)
    try {
      if (pinDialog === 'approve') {
        await approveWithPin(pendingAction.id, pinValue, sessionIdRef.current)
        setPinDialog(null)
        setPinValue('')
        setDeviceApprovalStep('approved')
        await executeConfirmedAction()
      } else if (pinDialog === 'set') {
        await setPin(pinValue)
        setPinStatus((current) => ({ ...current, configured: true }))
        setPinDialog(null)
        setPinValue('')
        announce(en.pin.ready)
      } else if (pinDialog === 'change') {
        if (pinCurrent.length !== 6) {
          announce('Enter your current six digit PIN first.', 'error')
          return
        }
        await changePin(pinCurrent, pinValue)
        setPinDialog(null)
        setPinValue('')
        setPinCurrent('')
        announce(en.pin.changed)
      }
    } catch (error) {
      announce(error.message || 'The PIN did not work. Try again.', 'error')
    } finally {
      setDeviceBusy(false)
    }
  }, [announce, executeConfirmedAction, pendingAction, pinCurrent, pinDialog, pinValue])

  const openPinEntry = useCallback((mode) => {
    setPinValue('')
    setPinCurrent('')
    setPinDialog(mode)
    announce(mode === 'approve' ? `${en.pin.warning} ${en.pin.noVoice}` : mode === 'change' ? en.pin.current : en.pin.new)
  }, [announce])

  const setupDevice = async () => {
    if (deviceBusy) return
    if (webauthnDiagnostics.inAppBrowser) {
      const text = 'Please open this page in Chrome or Safari, then press Set up this device again.'
      setWebauthnDiagnostics((current) => ({ ...current, lastError: { name: 'NotAllowedError', message: 'In-app browser detected.' }, lastFix: text }))
      announce(text, 'error')
      return
    }

    if (!window.isSecureContext) {
      const text = 'This page is not secure. Open VoicePay at its HTTPS address in Chrome or Safari.'
      setWebauthnDiagnostics((current) => ({ ...current, lastError: { name: 'SecurityError', message: 'Not a secure context.' }, lastFix: text }))
      announce(text, 'error')
      return
    }
    if (!deviceSupported) {
      const text = 'This browser cannot use secure device confirmation. Try a recent Chrome or Safari browser on a device with a screen lock.'
      setWebauthnDiagnostics((current) => ({ ...current, lastError: { name: 'NotSupportedError', message: 'Platform authenticator is unavailable.' }, lastFix: text }))
      announce(text, 'error')
      return
    }
    setDeviceBusy(true)
    try {
      await registerDevice()
      await refreshDeviceStatus()
      announce('This device is ready for secure confirmation.')
      vibrate([120, 80, 120])
    } catch (error) {
      const fixes = {
        SecurityError: 'Check the site address in Settings and use the stable VoicePay address.',
        NotAllowedError: 'Try again from a tap in Chrome or Safari. Make sure your device has a screen lock.',
        NotSupportedError: 'Use a recent Chrome or Safari browser on a device with a screen lock.',
        InvalidStateError: 'This device is already registered. Use Remove this device, then set it up again if needed.',
      }
      const text = fixes[error.name] || `This device could not be set up. ${error.message || 'Please try again.'}`
      setWebauthnDiagnostics((current) => ({ ...current, lastError: { name: error.name || 'Error', message: error.message || 'Unknown error' }, lastFix: text }))
      announce(text, 'error')
      vibrate([80, 60, 80])
    } finally {
      setDeviceBusy(false)
    }
  }

  const forgetDevice = async () => {
    if (deviceBusy || !deviceStatus.registered) return
    setDeviceBusy(true)
    try {
      await removeDevice()
      await refreshDeviceStatus()
      localStorage.setItem('voicepay-device-registered', 'false')
      announce('This device was removed. Set it up again before your next payment.')
    } catch (error) {
      announce(`The device could not be removed. ${error.message || 'Please try again.'}`, 'error')
    } finally {
      setDeviceBusy(false)
    }
  }

  const pageClass = `app-shell theme-${settings.theme} text-${settings.textSize}`
  return (
    <div className={pageClass}>
      <a className="skip-link" href="#conversation">Skip to conversation</a>
      <header className="site-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Icon name="logo" size={30} /></span>
          <div>
            <h1>VoicePay</h1>
          </div>
        </div>
        <div className="header-actions">
          <StatusPill connectionStatus={connectionStatus} onRetry={checkHealth} />
          <button type="button" className="secondary-button settings-button" onClick={() => setShowSettings(true)}><Icon name="settings" size={18} />{en.settings}</button>
        </div>
      </header>

      <main className="page-main">
        <div className="main-column">
          <section className="welcome-panel" aria-labelledby="welcome-heading">
            <p className="greeting">{getGreeting()}</p>
            <h2 id="welcome-heading">What would you like to do?</h2>
            <p className="welcome-copy">{en.welcomeCopy}</p>
            <div className="action-grid" aria-label="Main actions">
              {QUICK_ACTIONS.slice(0, 6).map((action) => <ActionTile key={action[0]} action={action} onClick={() => sendMessage(action[1].message)} />)}
            </div>
          </section>

          <section id="conversation" className="conversation" aria-labelledby="conversation-heading" aria-live="polite" ref={conversationRef}>
            <div className="section-heading">
              <div>
                <h2 id="conversation-heading">Conversation</h2>
              </div>
                  {isThinking && <p className="thinking" role="status"><span className="thinking-dot" aria-hidden="true">•••</span> {en.mic.thinking}</p>}
            </div>
            {messages.length === 0 ? (
              <p className="empty-state"><span className="empty-illustration" aria-hidden="true"><Icon name="logo" size={52} /></span>{en.emptyState}</p>
            ) : (
              <ol className="message-list">
                {messages.map((entry) => <MessageBubble key={entry.id} entry={entry} onRepeat={speak} onCopy={copyText} />)}
              </ol>
            )}
          </section>

          {caption && <section className="caption-strip" aria-label="Last spoken sentence"><span className="caption-label">{en.lastSpoken}</span><p>{caption}</p></section>}

          <section className="quick-actions" aria-labelledby="quick-actions-heading">
            <h2 id="quick-actions-heading">More ways</h2>
            <div className="quick-grid">
              {QUICK_ACTIONS.slice(0, 6).map((action) => <ActionTile key={action[0]} action={action} onClick={() => handleQuickAction(action[1].message)} />)}
              <ActionTile action={QUICK_ACTIONS[6]} onClick={() => handleQuickAction('repeat')} />
            </div>
          </section>
        </div>

        <aside className="side-panel" aria-label="VoicePay tools">
          {pendingAction && !isMobile && <PendingActionCard pendingAction={pendingAction} expiryText={expiryWarning} onConfirm={() => handlePending('confirm')} onCancel={() => handlePending('cancel')} pendingRef={pendingRef} isSending={isSending} onHear={hearProduct} onBuy={sendMessage} deviceApprovalStep={deviceApprovalStep} onDeviceApprove={handleDeviceApprove} onPinApprove={() => openPinEntry('approve')} pinAvailable={pinStatus.allowed && pinStatus.configured} deviceSupported={deviceSupported} deviceError={deviceError} />}
          <section className="side-card" aria-labelledby="recent-heading">
            <h2 id="recent-heading">My payments</h2>
            <p>Your latest payment activity will appear in the conversation when you ask for it.</p>
            <button type="button" className="secondary-button full-width" onClick={() => sendMessage(en.actions.payments.message)}><Icon name="receipt" size={20} />Check recent payments</button>
          </section>
          <section className="side-card safety-card" aria-labelledby="safety-heading">
            <h2 id="safety-heading">{en.nothingPaid}</h2>
            <p>VoicePay checks each payment again before anything happens.</p>
          </section>
        </aside>
      </main>

      {resultBanner && <div className={`result-banner result-${resultBanner.kind}`} role="region" aria-label="Latest result"><span className="result-icon" aria-hidden="true"><Icon name={resultBanner.kind === 'error' ? 'warning' : 'check'} size={30} /></span><p>{resultBanner.text}</p><button type="button" className="text-button" onClick={() => setResultBanner(null)}>Dismiss</button></div>}

      <footer className="site-footer">
        <div className="shortcut-line"><h2>Keyboard shortcuts</h2><p><kbd>Space</kbd> talk <span aria-hidden="true">·</span> <kbd>Escape</kbd> cancel <span aria-hidden="true">·</span> <kbd>R</kbd> repeat</p></div>
        <div className="input-dock">
          <p className="request-status" role="status">{requestStatus}</p>
          <div className={`listening-indicator ${isListening ? 'active' : ''}`} role="status" aria-live="polite">
            <span className="listening-rings" aria-hidden="true"><Icon name={isListening ? 'mic' : 'speaker'} size={22} /></span>
            <span>{isListening ? `${en.mic.listening} ${en.mic.stop}` : en.mic.ready}</span>
          </div>
          <button type="button" className={`speak-button ${isListening ? 'is-listening' : ''}`} onClick={handleSpeakClick} onPointerDown={handleSpeakPointerDown} onPointerUp={handleSpeakPointerUp} onPointerCancel={handleSpeakPointerUp} onKeyDown={handleSpeakKeyDown} onKeyUp={handleSpeakKeyUp} aria-pressed={isListening} aria-label={isListening ? 'Tap to stop listening' : 'Hold and talk'}>
            <span className="mic-icon" aria-hidden="true"><Icon name={isListening ? 'stop' : 'mic'} size={48} /></span><span>{isListening ? en.mic.listening : en.mic.ready}</span>
          </button>
          <form className="message-form" onSubmit={(event) => { event.preventDefault(); sendMessage(message) }}>
            <label htmlFor="message">Type a message</label>
            <div className="input-row">
              <input id="message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="For example: send 20 dollars to Nimal" autoComplete="off" />
              <button type="submit" className="primary-button" disabled={isSending || !message.trim()}><Icon name="send" size={20} />{en.mic.send}</button>
            </div>
          </form>
        </div>
      </footer>

      {isSpeaking && <p className="speaking-indicator" role="status"><Icon name="speaker" size={20} /> {en.mic.speaking}</p>}
      {pendingAction && isMobile && (
        <div className="mobile-dialog-layer">
      <PendingActionCard pendingAction={pendingAction} expiryText={expiryWarning} onConfirm={() => handlePending('confirm')} onCancel={() => handlePending('cancel')} pendingRef={pendingRef} isSending={isSending} isDialog onHear={hearProduct} onBuy={sendMessage} deviceApprovalStep={deviceApprovalStep} onDeviceApprove={handleDeviceApprove} onPinApprove={() => openPinEntry('approve')} pinAvailable={pinStatus.allowed && pinStatus.configured} deviceSupported={deviceSupported} deviceError={deviceError} />
        </div>
      )}
      {showSettings && <SettingsDrawer settings={settings} speechRate={speechRate} onSettingsChange={updateSettings} onSpeechRateChange={updateSpeechRate} onClose={() => setShowSettings(false)} speak={speak} deviceStatus={deviceStatus} deviceSupported={deviceSupported} deviceBusy={deviceBusy} onRegisterDevice={setupDevice} onRemoveDevice={forgetDevice} onSetPin={() => openPinEntry(pinStatus.configured ? 'change' : 'set')} pinStatus={pinStatus} onRunSetup={() => beginSetup(1)} onFixMicrophone={() => beginSetup(2)} onFixDevice={() => beginSetup(3)} diagnostics={webauthnDiagnostics} onCopyLink={() => { navigator.clipboard?.writeText(window.location.href); announce('The link was copied. Open it in Chrome or Safari.') }} />}
      {pinDialog && <PinDialog mode={pinDialog} value={pinValue} currentValue={pinCurrent} onValueChange={(value) => { setPinValue(value); announcePinDigit(value) }} onCurrentChange={setPinCurrent} onDone={submitPin} onCancel={() => setPinDialog(null)} />}
      {setupOpen && <SetupDialog step={setupStep} micStatus={micStatus} deviceSupported={deviceSupported} deviceStatus={deviceStatus} busy={setupBusy} onContinue={continueSetup} onDeviceSetup={guidedDeviceSetup} onPinSetup={() => openPinEntry('set')} pinAvailable={pinStatus.allowed && pinStatus.configured === false} onPractice={practiceSetup} onSkip={skipSetup} onBack={() => { setSetupStep((current) => Math.max(1, current - 1)); setupMessage(en.setup.back) }} onRepeat={() => setupMessage(setupStep === 1 ? en.setup.welcome : setupStep === 2 ? en.setup.microphonePermission : setupStep === 3 ? en.setup.deviceIntro : en.setup.practiceIntro)} onFinish={() => finishSetup()} onUseTyping={useTypingInstead} />}
    </div>
  )
}

export default App

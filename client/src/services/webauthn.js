import { startAuthentication, startRegistration } from '@simplewebauthn/browser'

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || 'Secure confirmation could not be completed.')
    error.code = data.code
    error.name = data.name || data.code || error.name
    throw error
  }
  return data
}

export async function isSupported() {
  if (!window.PublicKeyCredential) return false
  return window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
    ? window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    : false
}

export async function isPlatformAuthenticatorAvailable() {
  if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) return false
  return window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
}

export function isInAppBrowser() {
  return /FBAN|FBAV|Instagram|WhatsApp|Line\/|TikTok|BytedanceWebview|Twitter|Snapchat|Pinterest/i.test(navigator.userAgent || '')
}

export async function getWebAuthnConfig() {
  return request('/api/webauthn/config')
}

export async function registerDevice(deviceLabel = 'This device') {
  const options = await request('/api/webauthn/register/options', { method: 'POST', body: '{}' })
  const response = await startRegistration({ optionsJSON: options })
  return request('/api/webauthn/register/verify', {
    method: 'POST',
    body: JSON.stringify({ response, deviceLabel }),
  })
}

export async function approveAction(actionId, sessionId) {
  const options = await request('/api/webauthn/approve/options', {
    method: 'POST',
    headers: { 'X-Session-Id': sessionId },
    body: JSON.stringify({ actionId }),
  })
  const response = await startAuthentication({ optionsJSON: options })
  return request('/api/webauthn/approve/verify', {
    method: 'POST',
    headers: { 'X-Session-Id': sessionId },
    body: JSON.stringify({ actionId, response }),
  })
}

export async function practiceApproval() {
  const options = await request('/api/webauthn/practice/options', {
    method: 'POST',
    body: '{}',
  })
  const response = await startAuthentication({ optionsJSON: options })
  return request('/api/webauthn/practice/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  })
}

export async function getDeviceStatus() {
  return request('/api/webauthn/status')
}

export async function removeDevice() {
  return request('/api/webauthn/credentials', { method: 'DELETE' })
}

export async function getPinStatus() {
  return request('/api/pin/status')
}

export async function setPin(pin) {
  return request('/api/pin/set', { method: 'POST', body: JSON.stringify({ pin }) })
}

export async function changePin(currentPin, pin) {
  return request('/api/pin/change', { method: 'POST', body: JSON.stringify({ currentPin, pin }) })
}

export async function approveWithPin(actionId, pin, sessionId) {
  return request('/api/pin/approve', {
    method: 'POST',
    headers: { 'X-Session-Id': sessionId },
    body: JSON.stringify({ actionId, pin }),
  })
}

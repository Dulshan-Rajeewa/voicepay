# VoicePay

## Problem

Online payments can be difficult to complete independently for blind, deaf, and deafblind people.

## Solution

VoicePay is a voice-first and text-first assistant for accessible PayPal payments and online shopping.

## Features

- Send money to contacts and shop online through an accessible assistant.
- Voice and text interaction with equivalent visible text output.
- Explicit confirmation before any payment is submitted.

## Architecture

- `server/`: Express API, agent orchestration, pending actions, and PayPal sandbox integration.
- `client/`: React and Vite accessible user interface.
- The client proxies `/api` requests to the local Express server during development.

## Setup

1. Install dependencies with `npm install` in the repository root.
2. Copy `server/.env.example` to `server/.env`.
3. Keep `USE_MOCK_PAYPAL=true` for local development, or provide PayPal sandbox credentials.
4. Run `npm run dev`.

## Demo

Open the Vite URL shown in the terminal and try the accessible text-first payment flow.

## Tech used

Node.js, Express, React, Vite, Gemini via `@google/genai`, and PayPal REST APIs in sandbox mode.

## Accessibility

VoicePay is designed for keyboard users and screen readers, with semantic HTML, ARIA labels, high contrast, large targets, live response text, and no sight- or hearing-only interaction.

## Safety design

The LLM can only create pending actions. Plain server code submits a payment only from `POST /api/confirm` after explicit user confirmation. Server-side amount, currency, email, and maximum-payment validation applies to every payment.

## PayPal sandbox notes

Set `USE_MOCK_PAYPAL=true` for a deterministic local demo. For sandbox API calls, set `USE_MOCK_PAYPAL=false`, provide the sandbox client ID and secret in `server/.env`, and keep `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`.

Payouts may require Payouts access to be enabled for the PayPal developer app. Sandbox transaction reporting can lag behind recent activity, and some reporting data may be unavailable until transactions are processed. Use separate sandbox buyer and seller accounts, and configure the app's return URLs if the hosted approval flow is used.

Run the PayPal service smoke test with:

```powershell
node server/scripts/test-paypal.js
```

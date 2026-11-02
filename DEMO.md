# VoicePay demo script

This script is designed to finish in under three minutes. Use mock mode for reliability.

## Before recording

```powershell
npm install
Copy-Item server/.env.example server/.env
npm run demo:reset --prefix server
$env:USE_MOCK_PAYPAL='true'
npm run dev
```

Open `http://localhost:5173`. Keep the browser zoom at 100 percent or higher and keep the Conversation and confirmation panel visible.

## Script

### 0:00 to 0:20 — Introduce the problem

Say:

> “VoicePay helps blind, deaf, and deafblind people make payments independently. Every spoken response is also visible text, and every payment needs an explicit confirmation.”

Press Tab once to show the skip link, then Tab to “Hold to speak”. Say:

> “The interface is keyboard-friendly, screen-reader-friendly, and does not depend on sight or sound alone.”

### 0:20 to 0:50 — Check recent payments

Focus the message field and type exactly:

> `show my recent payments`

Press Enter. Point to the visible response and let speech synthesis read it.

Say:

> “The assistant can read recent payments, but the model cannot move money.”

### 0:50 to 1:35 — Propose and confirm a payment

Type exactly:

> `send 20 dollars to Nimal`

Press Enter. Wait for the confirmation panel.

Say:

> “This is a pending action. The summary is read aloud and shown as text. The user must confirm.”

Activate “Confirm”. Wait for:

> “Your payment is complete.”

Then say:

> “In mock mode this is a safe simulated result. In Sandbox mode this is where the server calls PayPal after confirmation.”

### 1:35 to 2:20 — Search and propose a purchase

Type exactly:

> `find tactile products`

Then type:

> `describe the braille notebook`

Point out that the description includes text such as size, materials, tactile features, and sound or voice features. Type:

> `buy one braille notebook`

Say:

> “Product information is not image-only. The assistant uses catalog facts to create a natural audio description.”

Activate “Cancel”. Confirm that the response says the pending action was cancelled.

### 2:20 to 2:50 — Safety and accessibility close

Press `R` to repeat the last response. Adjust Speech rate and press `R` again.

Say:

> “Space starts voice input, Escape cancels, and R repeats. The server validates the amount, currency, email, expiry, session ownership, and confirmation again at execution time.”

Finish with:

> “VoicePay makes payment assistance more private, understandable, and independent.”

## Fallback if Gemini is unavailable

Keep the screen visible and show the calm error message. Explain that the mock PayPal services are independent, while Gemini requires `GEMINI_API_KEY`. For a successful AI demo, set the key in `server/.env`, restart `npm run dev`, and run `npm run demo:reset --prefix server` again.

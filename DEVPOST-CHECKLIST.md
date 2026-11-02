# PayPal AI Hackathon submission checklist

## Required submission items

- [ ] Public repository URL is submitted and the repository is accessible without credentials.
- [ ] Root [LICENSE](./LICENSE) is visible and contains the MIT License text.
- [ ] Root [README.md](./README.md) contains the problem, solution, features, architecture, setup, PayPal usage, AI usage, accessibility, limitations, and future work.
- [ ] [DEMO.md](./DEMO.md) contains an under-three-minute scripted demo with exact phrases.
- [ ] A working demo has been run from a clean checkout with `npm install`, `npm run demo:reset --prefix server`, and `npm run dev`.
- [ ] `USE_MOCK_PAYPAL=true` is used for reliable judging when Sandbox credentials or capabilities are unavailable.
- [ ] Sandbox credentials are configured only in `server/.env`, never in the public repository.
- [ ] PayPal Sandbox setup, test accounts, and limitations are documented in README.md.
- [ ] The public description names the tools and technologies used: Node.js, Express, React, Vite, Gemini via `@google/genai`, Web Speech API, and PayPal REST APIs.
- [ ] The AI safety design is demonstrated: tools create pending actions, and plain server code moves money only after explicit confirmation.
- [ ] Accessibility is demonstrated with keyboard use and a screen reader; use [ACCESSIBILITY-MANUAL-TEST.md](./ACCESSIBILITY-MANUAL-TEST.md).
- [ ] A YouTube demo video is under three minutes.
- [ ] The YouTube video contains no copyrighted music.

## Final verification commands

```powershell
npm install
npm run demo:reset --prefix server
npm test --prefix server
npm run test:paypal --prefix server
npm run lint --prefix client
npm run build --prefix client
npm run dev
```

## Video checklist

- [ ] Show the accessible interface and text alternative.
- [ ] Show recent payments.
- [ ] Show a pending payment summary and explicit confirmation.
- [ ] Show product search and an accessible product description.
- [ ] Show purchase cancellation.
- [ ] Mention mock mode and PayPal Sandbox mode.
- [ ] Mention that no real production money is used.
- [ ] Confirm the video has no copyrighted music.

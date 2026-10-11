# Steeradar v6.1 — what was fixed

All changes are in this folder. Replace the files in your repo with these (keep `LICENSE`, `styles.css`), then follow **Backend Setup** in `README.md`.

## Do these 4 things after copying the files
1. **Create a NEW Apps Script project** from `Code.gs` (README → Backend Setup) and paste its `/exec` URL into `config.js`.
2. **Retire the old deployment** (Apps Script → Deploy → Manage deployments → archive). The old URL and the key `steeradar-secret-2026` are public in your git history, so assume that old Sheet's data is readable by anyone.
3. Delete `app-old.js` and `test.html` from the repo (they are not in this folder).
4. Hard-refresh the live site (Ctrl+Shift+R) so the browser picks up the new modules.

## Security fixes
| Issue | Fix | Files |
|---|---|---|
| Shared secret shipped to every browser | Removed. Per-user session tokens (hashed server-side, 90-day, revocable) | `config.js`, `js/api.js`, `Code.gs` |
| Anyone could edit/delete any lane/post, spoof presence, read any chat, set likes | Server derives owner from the token; ownership checks on every write; one like per user; DM rooms limited to the two plates | `Code.gs` |
| Stored XSS through `lane.id` | `esc()` on every attribute **and** server only accepts ids `[A-Za-z0-9_-]{1,64}` | `js/lanes.js`, `Code.gs` |
| Phone numbers broadcast in lanes/presence | Never sent by the client, never returned by the server | `js/lanes.js`, `js/presence.js`, `Code.gs` |
| Precise live location visible to strangers | Strangers get ~110 m precision; owner sees exact | `Code.gs` |
| Login OTP could be sent to an attacker's email | Login OTP only goes to the registered email; register must use the verified email; single-use, expiry, 5 attempts, rate limits | `Code.gs` |
| `completeLogin` sent an empty/stale token | Login now relies on the server-verified OTP | `js/auth.js`, `js/api.js` |
| Plate squatting on the server | One plate = one account | `Code.gs` |
| Peer data trusted blindly (hive posts, hello, chat) | Whitelist + length caps on all inbound peer payloads | `js/app.js`, `js/presence.js`, `js/chat.js` |
| Formula injection into Sheets | All cells written as plain text | `Code.gs` |
| Private plate/UPI photos | Stored as private Drive files, never linked | `Code.gs`, `js/photos.js` |

## Bug fixes
| Bug | Fix |
|---|---|
| Chat / Track / Hive broadcast dead (`window.Steeradar` never created) | Bridge object created in `app.js` |
| Inbound local-mesh chat dead | `presence.onPeerMessage` now wired to `chat.receive` |
| Incoming 1:1 messages shown in whatever room was open | Routed to the correct private DM room; unread messages toast |
| Duplicate chat rows / wrong `from` | Only the sender persists; server stamps sender |
| Your own history appeared as the other person's | History side decided by plate |
| Drivers published as "Name (You)" | Plain name; the card has its own YOU tag |
| Ghost mode inverted (hid your own map) | Ghost removes you from presence and publishes lanes without GPS |
| "Share exact GPS" ignored when posting lanes | Respected (lane published without coordinates) |
| Plate / UPI toggles saved but unused | Plate toggle now controls masked plate display. The UPI toggle is still unused (UPI flow is on the roadmap) |
| Changing vehicle in Settings dropped other toggles | Toggles saved first; server checks plate availability |
| `api.list()` returned `[]` on failure → UI wiped cloud lanes on outage | Returns `null`; callers keep existing data |
| "Request sent" shown even if driver offline | Honest delivered / not-delivered toasts |
| Fake ★ 5.0 rating, "ON TIME", random RSSI, random radar distances | Removed (masked plate shown; items without real coordinates are skipped) |
| `storage.set` could throw (private mode / quota) | try/catch |
| `unavailable-id` peer fallback broke routing | Receivers read the sender's plate from connection metadata |
| Pinch-zoom disabled, icon buttons unlabeled | Zoom enabled; `aria-label`s and `role="dialog"` added |
| 2.4 MB logo | 56 KB (same filename) |

## Behaviour changes you should know about
- **Publishing lanes/posts and chatting now require signing in** (the server enforces it). Signed-out users can still browse lanes and hive and keep their own lanes locally.
- Chat rooms are now **private 1:1** (`dm-PLATE-PLATE`) instead of one shared room per lane.
- Live presence / "Near" vehicles need a signed-in account.
- Existing data in the old Sheet is not migrated (schema changed). Start fresh on the new project.

## Known gaps (not fixed here — be upfront with users)
- Photo upload from the first-run gate is local-preview only (the inline gate script never called the uploader). `photos.js` + `onboarding.js` now upload via the session if you wire `initOnboarding`, but I did not change the gate flow.
- No CSP / SRI yet (see snippet below); no service worker / PWA manifest; no accept/decline seat-request flow; ratings and UPI payment flow are still roadmap.
- Apps Script + Sheets will not scale past a small community (quotas, polling). Plan a move to Supabase/Cloudflare D1 when you outgrow it — `js/api.js` is the only file that needs to change.
- I could not run the app in a real browser here. Backend security logic is covered by `node tests/backend.test.js` (61 checks, mocked Google services); the client was verified by syntax checks, a full module-load test with stubbed browser globals, and targeted greps. **Smoke-test on a phone before announcing.**

## Optional CSP (add inside `<head>` once you've tested it)
```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: blob: https://tile.openstreetmap.org https://*.openfreemap.org https://raw.githubusercontent.com; connect-src 'self' https://script.google.com https://script.googleusercontent.com https://*.openfreemap.org https://nominatim.openstreetmap.org https://router.project-osrm.org https://tile.openstreetmap.org https://0.peerjs.com wss://0.peerjs.com; worker-src blob:; child-src blob:; font-src 'self' data: https://*.openfreemap.org">
```
Test the map, chat and tracking after adding it; relax the specific directive the browser console complains about.

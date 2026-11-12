# Concept: Microsoft Outlook / Microsoft 365 Mail Integration

## Approaches at a Glance

| | **App Password** (simpler) | **OAuth 2.0 / Graph API** (full) |
|---|---|---|
| Admin action required | None (if tenant allows it) | App registration or consent grant |
| Code changes | None — existing IMAP works | New module + routes + UI |
| MFA bypassed | Yes (by design) | No — MFA is part of the flow |
| Works on locked-down tenants | No | Yes (with admin consent) |
| Token/secret rotation | Manual (user regenerates) | Automatic refresh |
| Recommended for | Personal / SMB M365 accounts | Corporate tenants with Conditional Access |

---

## Option 1: App Password (No Code Changes Required)

Microsoft allows users to generate **App Passwords** — static passwords that bypass
MFA for legacy protocols like IMAP. If the tenant permits them, this is the simplest
path: the existing IMAP integration works without modification.

### How to generate an App Password

1. User visits **myaccount.microsoft.com** → Security → Advanced security options →
   App passwords → Create
2. Give it a name (e.g. "Kanban Dashboard") and copy the generated password
3. In the kanban dashboard settings, add a mail account with:
   - **Host**: `outlook.office365.com`
   - **Port**: `993`, TLS enabled
   - **User**: full UPN (e.g. `alice@contoso.com`)
   - **Password**: the generated App Password (not the regular login password)

That's it — no Azure registration, no OAuth flow, no code changes.

### Limitations

- **Tenant policy can block it**: if the tenant enforces "Require approved client apps"
  or "Require MFA for all apps" via Conditional Access, App Passwords may be disabled.
  The user will see an IMAP authentication failure with no clear error message.
- **Security info access**: the "Advanced security options" page may itself be
  restricted by the tenant admin, making App Passwords unavailable to regular users.
- **No automatic rotation**: if the App Password is revoked or regenerated, the kanban
  config must be updated manually.
- **Microsoft deprecation risk**: Microsoft has been tightening legacy auth over time;
  App Passwords currently remain supported but are considered a compatibility shim.
- **IMAP must be enabled**: tenant admins can disable IMAP for the mailbox or
  organisation-wide (Exchange Admin Center → Settings → Email apps).

### When to try first

App Passwords are the right starting point for:
- Personal Microsoft accounts (outlook.com, hotmail.com) — always available
- Small-business M365 tenants without strict Conditional Access
- Any scenario where the user has self-service access to their security settings

If IMAP authentication fails despite a correct App Password, the tenant is likely
enforcing Conditional Access and the OAuth 2.0 approach below is required.

---

## Option 2: OAuth 2.0 + Microsoft Graph API (Full Integration)

## Problem

The current mail integration (`dashboard/mail.js`) authenticates against IMAP servers
using a static username + password. Microsoft 365 accounts protected by SSO and
Multi-Factor Authentication (MFA / Microsoft Authenticator) do not accept plain
passwords over IMAP — even when Basic Auth is enabled in the tenant, Microsoft may
block it, and many organisations enforce Conditional Access policies that require
a modern auth flow. A different authentication mechanism is needed.

---

## Chosen approach: Microsoft Graph API + OAuth 2.0 Authorization Code Flow (PKCE)

Two options exist for accessing Outlook mail:

| | IMAP + XOAUTH2 | **Microsoft Graph API** (chosen) |
|---|---|---|
| Auth | OAuth 2.0 access token via `AUTH=XOAUTH2` SASL | OAuth 2.0 access token as Bearer header |
| Protocol | IMAP (port 993) | HTTPS REST |
| Admin setup | IMAP must be enabled in M365 admin centre | Only app registration required |
| Reliability | Microsoft is actively deprecating Basic Auth / IMAP | Strategic/preferred Microsoft path |
| Coverage | Standard IMAP only | Full Outlook feature set (categories, meetings, etc.) |

Graph API is preferred because:
- No dependency on tenant-level IMAP configuration
- Single HTTP connection per request (no persistent TCP/TLS IMAP session)
- Already uses `fetch` compatible patterns (no additional npm dependency)
- Microsoft's recommended path for modern apps

---

## OAuth 2.0 Flow Overview

```
Browser (dashboard settings)
  │
  │  1. "Connect Microsoft account" button
  │     → GET /api/dashboard/mail/oauth/start?accountId=<id>
  │
  ▼
Backend (dashboard.js route)
  │  2. Builds Microsoft authorisation URL with:
  │     - client_id, redirect_uri, scope, state (CSRF token), code_challenge (PKCE)
  │     Stores code_verifier + state in CouchDB (temporary, TTL 10 min)
  │
  │  3. Returns { authUrl } to browser
  │
  ▼
Browser
  │  4. Opens authUrl in a popup window (window.open)
  │
  ▼
Microsoft Identity Platform (login.microsoftonline.com)
  │  5. User logs in with SSO credentials
  │  6. MFA prompt → user approves in Microsoft Authenticator app
  │  7. Microsoft redirects to redirect_uri with ?code=...&state=...
  │
  ▼
Backend (OAuth callback route)
  │  GET /api/dashboard/mail/oauth/callback?code=...&state=...
  │  8. Validates state matches stored CSRF token
  │  9. Exchanges code for { access_token, refresh_token, expires_in }
  │     using code_verifier (PKCE)
  │ 10. Stores tokens server-side in CouchDB (never sent to browser)
  │ 11. Closes the popup / signals success to opener window
  │
  ▼
Backend (mail fetch)
 12. Uses access_token as Bearer in Graph API requests
 13. Refreshes token automatically when expired (using refresh_token)
```

---

## Azure AD App Registration (one-time setup by tenant admin)

Before any code changes, the tenant admin must register an application:

1. **Azure Portal** → Azure Active Directory → App registrations → New registration
2. **Name**: e.g. "Kanban Dashboard"
3. **Supported account types**: "Accounts in this organizational directory only" (single tenant)
   — or "Any Azure AD directory" for multi-tenant
4. **Redirect URI**: `https://<kanban-host>/api/dashboard/mail/oauth/callback` (type: Web)
5. Under **Certificates & secrets**: create a client secret (store as `MS_CLIENT_SECRET`)
6. Under **API permissions**: add Microsoft Graph delegated permissions:
   - `Mail.Read`
   - `Mail.ReadWrite` (needed for mark-read, move, delete)
   - `offline_access` (required for refresh tokens)
   - `User.Read` (to resolve the user's email address after auth)
7. Grant admin consent (or allow user consent, depending on tenant policy)

Configuration values the kanban app needs:
- `MS_CLIENT_ID` — Application (client) ID from the app registration
- `MS_CLIENT_SECRET` — Client secret value
- `MS_TENANT_ID` — Directory (tenant) ID, or `common` for multi-tenant

These are added as `.env` variables (alongside existing `COUCHDB_*` vars).

---

## Data Model Changes

### Dashboard config document (`jc-config-dashboard`)

Add `authType: "oauth2-microsoft"` to mail account objects:

```jsonc
{
  "mailAccounts": [
    {
      "id":       "ms-work",
      "label":    "Work (Microsoft 365)",
      "authType": "oauth2-microsoft",  // new field; absence means IMAP/password
      "user":     "alice@contoso.com", // UPN — set automatically after first OAuth
      "folder":   "Inbox",
      "maxMessages": 20,
      "trashFolder": "Deleted Items"   // Outlook default differs from IMAP "Trash"
    }
  ]
}
```

### OAuth token store (new CouchDB document)

Stored in `jc-config-dashboard` database, separate document per account:

```jsonc
// _id: "ms-oauth-<accountId>"
{
  "accountId":    "ms-work",
  "accessToken":  "<jwt>",
  "refreshToken": "<opaque>",
  "expiresAt":    "2026-07-20T10:00:00.000Z",  // ISO-8601
  "scope":        "Mail.Read Mail.ReadWrite offline_access User.Read"
}
```

Tokens are never included in `GET /api/dashboard/config` responses (same pattern as
passwords — `stripPasswords` extended to `stripSecrets`).

### Temporary OAuth state document

```jsonc
// _id: "ms-oauth-state-<state-nonce>"
{
  "accountId":    "ms-work",
  "codeVerifier": "<random 64-byte hex>",
  "expiresAt":    "2026-07-20T09:10:00.000Z"   // 10-min TTL
}
```

Deleted immediately after the callback is processed.

---

## New Backend Routes

All added to `routes/dashboard.js`, protected by the existing `authenticate` middleware.

```
GET  /api/dashboard/mail/oauth/start?accountId=<id>
     → { authUrl: "https://login.microsoftonline.com/..." }

GET  /api/dashboard/mail/oauth/callback?code=&state=
     → HTML page that calls window.opener.postMessage({ok:true}) then window.close()
     (this route is the redirect_uri; browsers open it in the popup)

POST /api/dashboard/mail/oauth/revoke/:accountId
     → revokes refresh token at Microsoft, deletes stored tokens; { ok: true }

GET  /api/dashboard/mail/:accountId/oauth-status
     → { connected: bool, user: string|null, expiresAt: string|null }
```

No new public routes — the callback URL is only called by Microsoft's redirect.

---

## New Backend Module: `dashboard/ms-graph.js`

Replaces `_makeClient()` + ImapFlow calls for OAuth-typed accounts:

```js
// Token management
async function getAccessToken(accountId)      // returns valid token, refreshes if needed
async function refreshAccessToken(accountId)  // exchanges refresh_token for new tokens
async function revokeToken(accountId)

// Mail operations (mirrors existing mail.js exports)
async function fetchMailAccount(account)                  // → summary array
async function fetchMailMessage(account, messageId)       // → full message
async function fetchMailAttachment(account, msgId, attId) // → { data, name, type }
async function testMailAccount(account)                   // → { ok, error? }
async function listMailFolders(account)                   // → [{ path, name }]
async function markMailMessage(account, messageId, seen)
async function moveMailMessage(account, messageId, targetFolder)
async function deleteMailMessage(account, messageId)
```

Graph API base: `https://graph.microsoft.com/v1.0/me/`

Key endpoint mappings:

| Current (IMAP) | Graph API equivalent |
|---|---|
| `INBOX` list | `GET /me/mailFolders/{folderId}/messages?$top=N&$orderby=receivedDateTime desc` |
| Fetch message | `GET /me/messages/{id}?$select=...` + `GET /me/messages/{id}/body` |
| List folders | `GET /me/mailFolders?$top=100` (+ recursive child folders) |
| Mark read | `PATCH /me/messages/{id}` `{ "isRead": true }` |
| Move message | `POST /me/messages/{id}/move` `{ "destinationId": "..." }` |
| Delete (trash) | `POST /me/messages/{id}/move` to "deleteditems" well-known folder |
| List attachments| `GET /me/messages/{id}/attachments?$select=id,name,size,contentType` |
| Get attachment | `GET /me/messages/{id}/attachments/{attId}/$value` |

Token refresh (called transparently by `getAccessToken`):

```
POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
  grant_type=refresh_token
  client_id=...
  client_secret=...
  refresh_token=<stored>
  scope=Mail.Read Mail.ReadWrite offline_access
```

---

## Routing Logic in `routes/dashboard.js`

The existing mail routes dispatch to the appropriate implementation based on account type:

```js
function _getMailImpl(account) {
  return account.authType === 'oauth2-microsoft'
    ? require('../dashboard/ms-graph')
    : require('../dashboard/mail');   // existing IMAP implementation unchanged
}

// Example — existing fetch handler:
router.get('/mail/:accountId', authenticate, async (req, res) => {
  const account = await getMailAccount(req.params.accountId);
  const impl = _getMailImpl(account);
  const msgs = await impl.fetchMailAccount(account);
  res.json(msgs);
});
```

Both implementations expose the same function signatures, so all existing routes
(`/mail/:id`, `/mail/:id/message/:uid`, PATCH, move, delete, folders, test) work
unchanged — only the transport layer differs.

---

## Frontend Changes (`dashboard.js` + settings UI)

### Account settings dialog

The mail account form gains a new "Auth type" toggle:
- **IMAP** (default): existing host/port/TLS/user/password fields, unchanged
- **Microsoft 365 (OAuth)**: hides host/port/password; shows:
  - "Connect Microsoft account" button → calls `/api/dashboard/mail/oauth/start`
  - Status indicator: "Connected as alice@contoso.com (token valid until ...)"
  - "Disconnect" button → calls `/api/dashboard/mail/oauth/revoke/:id`

### OAuth popup flow (frontend)

```js
async function _startMsOAuth(accountId) {
  const { authUrl } = await _apiFetch(`/api/dashboard/mail/oauth/start?accountId=${accountId}`).then(r => r.json());
  const popup = window.open(authUrl, 'ms-oauth', 'width=520,height=620');
  await new Promise((resolve, reject) => {
    const handler = (e) => {
      if (e.source !== popup) return;
      window.removeEventListener('message', handler);
      e.data?.ok ? resolve() : reject(new Error(e.data?.error || 'OAuth failed'));
    };
    window.addEventListener('message', handler);
    const timer = setInterval(() => { if (popup.closed) { clearInterval(timer); reject(new Error('Cancelled')); } }, 500);
  });
  // Reload dashboard config to show connected status
  await loadDashboard();
}
```

The callback page (served by the backend) posts back:
```html
<script>
  const p = new URLSearchParams(location.search);
  window.opener?.postMessage(
    p.has('error') ? { ok: false, error: p.get('error_description') } : { ok: true },
    location.origin
  );
  window.close();
</script>
```

---

## Re-authentication / Token Expiry

Refresh tokens for Microsoft 365 are long-lived (90 days inactive / 1 year max by
default, policy-configurable per tenant). The backend refreshes the access token
transparently before each API call when `expiresAt - now < 5 min`.

If the refresh token itself is revoked (user revokes consent, admin removes app, token
expired):
- The Graph API call returns 401
- `ms-graph.js` catches it, marks the account as `oauthExpired: true` in the token doc
- The dashboard `/api/dashboard/mail/:id` route returns `{ error: "oauth_expired" }` instead of messages
- The frontend shows a "Reconnect" banner for that account, triggering the popup flow again

---

## Security Considerations

| Risk | Mitigation |
|---|---|
| CSRF during OAuth callback | `state` nonce stored in CouchDB; validated on callback; deleted after use |
| Code interception | PKCE (`S256` code challenge); `code_verifier` never leaves the server |
| Token leakage to browser | Tokens stored only in CouchDB; never returned by any API response |
| Open redirect | `redirect_uri` is a fixed value registered in Azure AD; Microsoft rejects any other URI |
| Replay attack on callback | `state` doc deleted immediately after first use |
| Client secret exposure | Stored only in `.env` / server environment; never in the codebase or browser |
| Token at rest | CouchDB is already the trust boundary for passwords; same level of protection |

---

## Dependencies

No new npm packages required:

- OAuth HTTP calls use Node.js built-in `fetch` (Node 18+, already used elsewhere)
- Graph API responses are plain JSON; no SDK needed
- PKCE (`crypto.randomBytes`, `crypto.createHash`) uses Node.js built-in `crypto`

The only prerequisite is that `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and `MS_TENANT_ID`
are set in `.env`. If they are absent, the "Microsoft 365 (OAuth)" auth type option
is hidden in the UI (backend returns `{ msMail: false }` in `GET /api/settings`).

---

## Implementation Plan

1. **Azure AD setup** — tenant admin registers the app, provides client ID/secret/tenant ID
2. **`.env` + `config.js`** — add `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`; expose `msMail` flag in settings
3. **`global-db.js`** — add `getOAuthTokens(accountId)`, `saveOAuthTokens(...)`, `deleteOAuthTokens(...)`, `getOAuthState(nonce)`, `saveOAuthState(...)`, `deleteOAuthState(...)`
4. **`dashboard/ms-graph.js`** — implement `getAccessToken`, `refreshAccessToken`, all mail operation functions using Graph API
5. **`routes/dashboard.js`** — add OAuth start/callback/revoke routes; update dispatch logic (`_getMailImpl`); add `oauth-status` route
6. **Frontend: settings dialog** — add auth-type toggle, Connect/Disconnect buttons, status display
7. **Frontend: OAuth popup** — `_startMsOAuth` + `postMessage` handling
8. **Frontend: expired token banner** — detect `oauth_expired` in mail panel response
9. **Schemas** — extend mail account schema to allow `authType`, no `password` when OAuth
10. **Tests** — unit tests for `ms-graph.js` (mock `fetch`); API tests for OAuth routes (mock token exchange); E2E skipped (requires live Microsoft tenant)

---

## Out of Scope

- **Calendar OAuth**: Outlook calendar via Graph API is a separate but parallel effort;
  the same Azure app registration and token infrastructure can be reused
- **Multi-tenant / personal accounts**: the OAuth concept targets a single organisation
  tenant; multi-tenant (`common` endpoint) requires additional consent UX. Personal
  accounts (outlook.com) are better served by Option 1 (App Password)
- **Send mail**: read-only + flag/move/delete covers the dashboard use case; adding
  `Mail.Send` scope is a future extension
- **Per-user access control**: the kanban app is single-user; there is no per-user token
  isolation to implement

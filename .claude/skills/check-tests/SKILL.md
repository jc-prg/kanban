---
name: check-tests
description: >
  Analyze a feature request against the project's test concept and produce a concrete test checklist.
  Use this skill whenever the user describes a new feature, API endpoint, state mutation, or UI behavior
  they plan to implement — especially for anything non-trivial. Trigger on phrases like: "I want to add",
  "implement X", "build a feature", "add support for", "create an endpoint", "add an API for", "new route",
  "let's build", or any description of planned functionality for the kanban app. The skill reads
  concepts/test-concept.md, identifies which layers the feature touches (backend API, unit state/render/notes,
  E2E, security), maps to existing test files and ID sequences, and outputs a structured checklist of tests
  to write alongside the feature — enforcing the "tests alongside features, not after" rule from section 9.2.
---

# Check Tests

Produce a pragmatic test checklist for the described feature. The goal is the minimum set of tests
that would catch real bugs — not exhaustive coverage of every boundary case.

## Step 1 — Read the test concept

Read `concepts/test-concept.md` in full. This is the authoritative reference for:
- Which test files exist and what they cover
- All existing test IDs (so you can continue the numbering)
- Phase status (what is done vs. pending)

## Step 2 — Identify which layers the feature touches

| Layer | Relevant if… | Test file |
|---|---|---|
| Backend API | New/changed routes, request validation, CouchDB mutations | `tests/api/<area>.test.js` |
| Unit — state | New state mutations, `buildPatch` changes, column actions | `tests/unit/state.test.js` |
| Unit — render | New badges, card/column DOM output, `escHtml`/`safeLink` | `tests/unit/render.test.js` |
| Unit — notes | Note tree operations, `buildNotesPatch`, folder/page mutations | `tests/unit/notes.test.js` |
| Unit — search | New filter types, accent-folding, date range logic | `tests/unit/search.test.js` |
| Unit — analytics | New computations over card data | `tests/unit/analytics.test.js` |
| E2E | Anything visible or interactive in the browser | `tests/e2e/<area>.spec.js` |
| Security | File uploads, user-supplied IDs/paths, auth bypass vectors | `tests/api/security.test.js` |

Omit layers the feature genuinely does not touch.

## Step 3 — Find the next available ID in each sequence

- Backend: `A-*` `B-*` `D-*` `I-*` `N-*` `WC-*` `NP-*` `NF-*` `NS-*` `WH-*` `CA-*` `SEC-*`
- Unit: `S-*` `R-*` `SR-*` `NT-*` `AN-*`
- E2E: `E-A-*` `E-O-*` `E-B-*` `E-D-*` `E-S-*` `E-N-*` `E-ST-*` `E-M-*` `E-I-*`

If the feature introduces a genuinely new domain, propose a new prefix that fits the pattern.

## Step 4 — Output the checklist

**Target: 3–8 tests total across all layers.** Ask yourself for each test: "Would this catch a real
bug that the others wouldn't?" If not, skip it.

Prioritise in this order:
1. **Happy path** — the main scenario works end-to-end
2. **Key failure modes** — the 1–2 most likely ways it breaks (wrong input, missing data, auth)
3. **Behavioural contract** — anything non-obvious that future code could accidentally break

For validation, group related checks into one test unless they exercise meaningfully different code paths.
For example, "invalid retryCount (negative, too large, wrong type)" is one test, not three.

E2E tests: only include one if the user flow is genuinely hard to cover at the unit/API level.
Security tests: only include if the feature introduces a new attack surface (new file upload, new
user-supplied path parameter, new unauthenticated endpoint).

---

## Test Checklist: [Feature Name]

> Add these rows to `concepts/test-concept.md` before coding (section 9.1 — spec before implementation).

### Backend API — `tests/api/[file].test.js`

| # | Test | Expected |
|---|---|---|
| [ID] | `[METHOD] /api/[route]` — [scenario] | [response code + body shape] |

### Unit — `tests/unit/[file].test.js`

| # | Test | Expected |
|---|---|---|
| [ID] | `[functionName]([args])` — [scenario] | [return value / state change] |

### E2E — `tests/e2e/[file].spec.js`

| # | Scenario | |
|---|---|---|
| [ID] | [what the user does] → [what they see] | |

### Security — `tests/api/security.test.js`

| # | Test | Expected |
|---|---|---|
| [SEC-N] | [attack vector] | 400 / unchanged state |

### Test concept doc updates

- [ ] Add all rows above to `concepts/test-concept.md` under the matching section
- [ ] Add a `[ ]` entry in the Phase checklist (section 7) for the relevant phase
- [ ] Run `/test` before tagging a release to confirm all pass

---

End with one sentence noting which test file gets the most new tests, and whether any fixtures need updating.

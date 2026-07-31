# Architecture

## The problem this solves

A browser agent built on a generic Playwright MCP server is slow for reasons that have
almost nothing to do with the browser. Measure a typical 25-step flow and the wall clock
breaks down roughly like this:

| Phase | Share of wall clock |
| --- | --- |
| LLM inference (one call per click) | 70–90 % |
| Perception (accessibility tree / screenshots) serialised into the prompt | 5–20 % |
| Actual browser work (navigate, click, type) | 2–10 % |

So the wins are, in order: **make fewer model calls**, **make each call carry fewer
tokens**, and only then **make the browser faster**. Every layer below is designed
against that ranking.

A second, structural problem: a generic driver is *blind*. It discovers a settings UI the
same way a first-time human user does — by clicking around and reading. But the
application's source code is usually sitting right there in the workspace, and it already
contains the route table, the tab definitions, the test ids and the config schema. Reading
it turns exploration into a lookup.

## Layers

```
L4  MCP surface        9 coarse tools, compact structured results
L3  Knowledge          code index (routes/selectors/config) + skill cache (compiled trajectories)
L2  Executor           guarded action programs, self-healing resolution, bulk form fill
L1  Page runtime       one injected script: one-eval snapshot, settle detection, find()
L0  Browser pool       warm contexts, per-workspace profiles, request blocking
```

Each layer only knows the one below it through the interfaces in `src/contracts.ts`.

---

## L0 — Browser pool and workspace isolation

**Warm contexts.** A cold Chromium launch costs 1–8 s (measured 8.2 s on a cold container,
~0.4 s warm). The pool keeps one persistent context per workspace and hands out tabs, so
only the first call in a session pays launch cost — and `fba warm` / `browser_session
{action:'warm'}` moves even that off the critical path.

**Per-workspace profiles.** Each workspace root maps to a stable id
(`<basename>-<hash8>` of the realpath) and therefore to its own Chromium
`user-data-dir` under `~/.faster-browser-agent/profiles/`. Two agents working in two git
worktrees get two cookie jars, two localStorage areas, two logged-in identities — no
cross-talk.

Worktrees are detected properly: a `.git` **file** (rather than a directory) means a linked
worktree, and the file's `gitdir:` pointer plus the adjacent `commondir` yields the real
repository root. The workspace identity stays the worktree path, so each worktree is
independent by default.

**Locking.** Two Chromium processes sharing a `user-data-dir` corrupt it. Every profile
carries a `.fba-lock` with the owning pid. A dead pid's lock is stolen; a *live* pid's lock
does not fail the call — the manager clones an **ephemeral profile** seeded from the
primary and deletes it on release. Parallel agents on the same workspace therefore degrade
to "separate but similar state" rather than to an error.

**Seeding.** `profiles seed --from A --to B` copies the cookie/localStorage/IndexedDB
state between profiles, so a freshly created worktree inherits a logged-in session instead
of redoing an OAuth dance.

**Request blocking.** Images, media and fonts are aborted by default, along with a list of
analytics/ads hosts. Documents and XHR/fetch are *never* blocked — the app needs its own
data. On heavy pages this roughly halves load time, and an agent never looks at a pixel of
what was dropped.

---

## L1 — The page runtime

The classic mistake is one CDP round trip per query: `page.$$eval` per selector, a separate
call for each attribute. A hundred of those is a few hundred milliseconds of pure latency,
repeated every step.

Instead a single self-contained script is injected via `addInitScript` (so it exists before
any page script runs) and exposes `window.__fba`. One `page.evaluate` returns the entire
observation.

**Snapshot.** One `TreeWalker` pass over the DOM produces a *tree* of interactive and
structurally meaningful nodes: role (normalised onto a small closed vocabulary), accessible
name, value, state flags, and a ref. Refs are written back onto the element as `data-fba`,
which makes them stable across re-snapshots and React re-renders — that stability is what
makes diffing possible.

Four compressions do the heavy lifting on token count:

1. **Viewport-first scoping** — off-screen nodes are dropped, but structural ancestors are
   kept so the tree still reads as a page.
2. **Overlay scoping** — when a modal is open, the tree is scoped to the modal. The rest of
   the page is one note, not 200 lines.
3. **Collapsed containers** — a collapsed accordion or an unselected tab panel is emitted as
   a single line with a child count, not expanded. Deep config UIs are mostly collapsed, so
   this is where the biggest savings come from.
4. **Repeat-pattern compression** — a 40-row table becomes 3 rows plus `… 37 more similar`.

**Settle detection.** `waitForTimeout(2000)` sprinkled through a script is the most common
hidden time sink. The runtime instead tracks DOM mutations (one `MutationObserver`) and
in-flight requests (patched `fetch`/`XHR` plus a `PerformanceObserver`), and resolves once
both have been quiet for their windows (300 ms network, 200 ms DOM) with a hard cap.
Crucially the wait resolves **in-page**, so it costs one round trip rather than a polling
loop. Most pages settle in 300–500 ms.

The Node side keeps its own in-flight counter from Playwright's `request`/`requestfinished`
events — free, no round trip, and it sees requests that started before injection. Settle
requires both halves to agree.

**find().** A ranked in-page search by role/name/text/label/placeholder/testId. This is the
backbone of self-healing: a stale ref never fails a step if the element is still findable.

---

## L2 — Action programs

The round-trip killer. Rather than `click` → observe → `type` → observe → `click`, the model
emits one guarded program:

```json
[ {"do":"selectTab","path":["Settings","Advanced"]},
  {"do":"type","target":{"label":"SMTP host"},"text":"smtp.acme.io","clear":true},
  {"do":"check","target":{"label":"Use TLS"},"checked":true},
  {"do":"click","target":{"role":"button","name":"Save"}},
  {"do":"assert","text":"Saved"} ]
```

Executed deterministically, returning one diff. Control returns to the model only on
divergence — which is what `assert` steps are for.

**Self-healing resolution.** Targets are over-specified on purpose. The resolver walks
`ref → testId → css → role+name → label → placeholder → text → name`, reports which
strategy won and whether it healed. Ambiguity is an error that *lists the top candidates*,
so disambiguation costs one round trip instead of a guess.

**Inter-step settling.** Short budgets between steps (150 ms quiet, 1.5 s cap), the full
budget only after the last one. Fixed sleeps are always wrong; full waits between every
step are wasteful.

**Bulk form fill.** `browser_form` matches human field names against the live control pool
(and the code index), picks the action from the *control's role* rather than the value's
type, skips fields already at the requested value, and runs everything as one program. A
30-field configuration page becomes one call.

---

## L3 — Knowledge: code index and skill cache

### Code index — the differentiator

The workspace is scanned (via `git ls-files`, an order of magnitude faster than a JS walk)
and mined with regexes rather than a parser — framework-agnostic, and fast enough to rebuild
a 2000-file repo in well under a second. It extracts:

- **Routes** from Next.js (app + pages), SvelteKit, Nuxt, Astro, Remix, React Router, Vue
  Router, Angular, Django, Rails, Flask/FastAPI.
- **Selectors** — `data-testid`/`data-cy`/`id`/`aria-label`/`placeholder` literals, plus
  `getByTestId(...)`/`getByRole(...)` from the existing test suite, which is a goldmine of
  known-good selectors.
- **Nav/tab groups** — declarative arrays like
  `[{ id:'general', label:'General' }, { id:'advanced', label:'Advanced' }]`, which describe
  exactly the tab structures agents otherwise have to discover by clicking.
- **Config fields** from zod/yup/JSON Schema/TS `*Config` interfaces, with enum values.
- **Base URL** inferred from dev scripts, vite/next config, `.env`, docker-compose.

The payoff: `browser_open {route: "settings/advanced"}` is a **deep link**. Reaching a
third-level config tab drops from three navigations and three snapshots to one navigation
and one snapshot. And `browser_find {query:"SMTP port"}` answers from the index — with the
source location — without touching the page.

### Skill cache — compiled trajectories

Once a flow succeeds, its action program is stored under `(origin, name)`. Replaying is pure
execution: **zero model calls**. Every `assert` recorded in the skill doubles as a verifier,
so a changed UI fails fast and honestly, and the caller falls back to model-driven navigation
and re-records. Recurring flows go from minutes to seconds.

---

## L4 — MCP surface

Tool definitions occupy the model's context on *every* call, so the surface is itself a
latency cost. Nine coarse tools, short descriptions, tight schemas — no fine-grained
`click`/`type`/`press` tools, because those are steps inside `browser_act`.

Results are compact indented text rather than JSON (braces and quotes are pure overhead) and
default to a **diff**:

```
@ tab Settings > General -> Settings > Advanced
~ e12 text "SMTP host" "" -> "smtp.acme.io"
~ e30 btn "Save" [disabled -> enabled]
```

Errors carry a code and a recovery hint, because an error that explains what to try next
costs one round trip while an opaque one costs several.

---

## Where the time actually goes now

| Operation | Before (generic driver) | Here |
| --- | --- | --- |
| Reach a 3rd-level config tab | 3 navigations + 3 snapshots + 3 model calls | 1 deep link + 1 snapshot + 1 model call |
| Observe a heavy settings page | full a11y tree, 20–50k tokens | scoped + compressed tree, ~1–2k tokens |
| Fill a 30-field form | ~30 model calls | 1 `browser_form` call |
| Repeat a known flow | full model-driven run | skill replay, 0 model calls |
| Wait after an action | fixed 2 s sleeps | settle heuristic, typically 300–500 ms |
| First browser call | 1–8 s cold launch | warm pool, ~0.4 s |

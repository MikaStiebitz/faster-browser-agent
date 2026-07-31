# faster-browser-agent

**A browser driver built for AI agents, not for test scripts.**

Generic Playwright MCP servers are slow for reasons that have little to do with the
browser. They make one model call per click, hand the model tens of thousands of tokens of
accessibility tree per step, and discover an application by clicking around it — even when
the application's source code, with its route table and tab definitions, is sitting right
there in the workspace.

This does the opposite. It reads your code first, deep-links instead of navigating,
executes guarded action *programs* instead of single actions, compresses what the model
sees by ~20x, and replays known flows with zero model calls. Every git workspace gets its
own browser identity, so parallel agents never share a cookie jar.

```
npx faster-browser-agent doctor     # check the install
npx faster-browser-agent mcp        # start the MCP server
```

---

## Why it's faster

Measured on this machine against `test/fixtures/config-app.html`, a settings page with
nested tabs, collapsed accordions, a 40-row table and a modal:

| What the model receives | Size |
| --- | --- |
| Raw DOM (`page.content()`) | 16,061 chars (~4,000 tokens) |
| Raw accessibility tree (JSON) | 31,933 chars (~8,000 tokens) |
| **This, whole page** | **1,438 chars (~360 tokens)** |
| **This, viewport (default)** | **1,359 chars (~340 tokens)** |

That is **22x smaller than the accessibility tree**, on a page far simpler than a real
admin panel. And the reduction compounds: it applies to *every* step of *every* flow.

Browser-side timings (`fba bench`, medians):

| Phase | |
| --- | --- |
| cold launch | 316 ms (8.2 s on a genuinely cold container) |
| warm acquire (new tab) | 87 ms |
| navigate | 48 ms |
| settle (DOM + network quiet) | 316 ms |
| snapshot, 97 interactive elements | 13 ms |
| serialize | 0.2 ms |

But the browser was never the bottleneck. This is:

| Task | Generic driver | Here |
| --- | --- | --- |
| Reach a 3rd-level config tab | 3 navigations, 3 snapshots, 3 model calls | 1 deep link, 1 snapshot, **1 model call** |
| Fill a 30-field settings form | ~30 model calls | **1 call** (`browser_form`) |
| Repeat a flow you already ran | full model-driven run | **0 model calls** (skill replay, 675 ms measured) |
| Wait after an action | fixed 2 s sleeps | settle heuristic, typically 300–500 ms |

---

## Install

Requires Node ≥ 20.10 and a Chromium. If you already have Playwright installed, its browser
is found automatically; otherwise point `FBA_CHROMIUM_PATH` at any Chrome/Chromium.

```bash
npm install -g faster-browser-agent
fba doctor
```

### As an MCP server

<details open>
<summary>Claude Code</summary>

```bash
claude mcp add browser -- npx -y faster-browser-agent mcp
```
</details>

<details>
<summary>Any MCP host (<code>.mcp.json</code>)</summary>

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "faster-browser-agent", "mcp"],
      "env": { "FBA_WORKSPACE": "/path/to/your/project" }
    }
  }
}
```
</details>

### As a Claude Code plugin

The repository is also a plugin: it ships the MCP server plus a `browser-power-user` skill
that teaches the agent the efficient usage patterns (batch actions, deep-link, don't
screenshot). Add the marketplace and install it, or copy `skills/browser-power-user/` into
your own `.claude/skills/`.

---

## The nine tools

Tool definitions sit in the model's context on *every* call, so the surface is itself a
latency cost. Nine coarse tools, not twenty fine-grained ones. There is deliberately no
`click` or `type` tool — those are steps inside `browser_act`.

| Tool | What it does |
| --- | --- |
| `browser_open` | Open a URL, **or a route resolved from your source code** |
| `browser_snapshot` | Observe — a diff by default, full tree on request |
| `browser_act` | Run a guarded action **program**: many steps, one call |
| `browser_form` | Fill many fields at once, by human label |
| `browser_find` | Locate by meaning across the live page *and* the code index |
| `browser_map` | The app's route/tab/config map — usually without a browser |
| `browser_extract` | Structured extraction, or replay an API the page itself called |
| `browser_skill` | Save and replay compiled trajectories (zero model calls) |
| `browser_session` | Per-workspace browser state: list, warm, reset, seed |

---

## What makes it different

### 1. It reads your code before it opens the page

The workspace is scanned via `git ls-files` and mined for routes (Next.js app + pages,
SvelteKit, Nuxt, Astro, Remix, React Router, Vue Router, Angular, Django, Rails,
Flask/FastAPI), `data-testid`/`aria-label` literals, declarative tab arrays, zod/JSON-Schema
config fields, and i18n catalogues. The dev-server port is inferred from your `dev` script,
vite/next config or `.env`.

```console
$ fba index
  frameworks     next-app
  base url       http://localhost:4321
  routes         4
  nav groups     1
  config fields  4
  build          19.0ms

$ fba map advanced
score  kind   label                    url / target                             source
 1.00  route  Advanced                 http://localhost:4321/settings/advanced  src/app/settings/advanced/page.tsx:1
 0.97  nav    Settings Tabs: Advanced  http://localhost:4321/settings/advanced  src/components/Tabs.tsx:2
```

So `browser_open {route: "settings/advanced"}` is a **deep link**, not three clicks. And
`browser_find {query: "SMTP port"}` answers from the schema — with the source location —
before touching the browser.

### 2. Perception is compressed, not dumped

One injected script returns the whole observation in a single round trip. Four compressions
do the work: viewport-first scoping, modal scoping (a dialog hides the page behind it),
collapsed containers emitted as one line with a child count, and repeat-pattern folding.

```
url: /  |  title: Acme Admin — Settings
tab: General
  e13 tablist "Settings sections"
    e14 tab "General" [selected]
    e15 tab "Network"
  e17 panel "General"
    e19 text "Organisation name" = "Acme Inc"
    e21 select "Default locale" = English (English|Deutsch|Français)
    e23 check "Email notifications" [checked]
  e26 table
    e28 row … +37 similar
[43 interactive, 45 shown, 99 elided, 7.7ms]
```

After the first look you get diffs, not trees:

```
@ tab Settings > General -> Settings > Advanced
~ e12 text "SMTP host" "" -> "smtp.acme.io"
~ e34 status "Saving…" -> "Saved"
```

### 3. Action programs, not one call per click

```json
{"steps": [
  {"do": "selectTab", "path": ["Network", "SMTP"]},
  {"do": "type",   "target": {"label": "SMTP host"}, "text": "smtp.acme.io", "clear": true},
  {"do": "check",  "target": {"label": "Use TLS"}, "checked": true},
  {"do": "click",  "target": {"role": "button", "name": "Save"}},
  {"do": "assert", "text": "Saved"}
]}
```

Executed deterministically; control returns to the model only on divergence. Targets are
self-healing — a stale `ref` falls through to `testId`, `role+name`, `label`, `text`, and
the step still runs. Ambiguity is never guessed: the error lists the candidates.

For configuration screens, `browser_form` is even denser — one call switched two tab levels,
filled four fields, submitted and verified:

```
SMTP host: ok -> "SMTP host" e41
SMTP port: ok -> "SMTP port" e42
Encryption: ok -> "Encryption" e45
submitted
4 filled, submitted — tab Network > SMTP
~ e34 status "Saving…" -> "Saved"
```

### 4. Flows you repeat cost nothing

```
browser_act   { steps: [...], record: "configure-smtp" }
browser_skill { action: "replay", name: "configure-smtp", params: { host: "smtp.acme.io" } }
```

Replay is pure execution — **zero model calls**, 675 ms measured. Every `assert` recorded
with the skill doubles as a verifier, so a changed UI fails fast and honestly instead of
half-executing.

### 5. Parallel agents get independent browsers

Each workspace root maps to its own Chromium profile directory. Git worktrees are detected
properly (a `.git` *file* → resolve `gitdir:`/`commondir`), so two agents on two branches
have two cookie jars and two logged-in identities.

Two Chromium processes sharing a `user-data-dir` corrupt it, so profiles are locked. A dead
lock is stolen; a **live** one does not fail the call — an ephemeral clone is created
instead. And a fresh worktree can inherit a login rather than redoing an OAuth dance:

```bash
fba profiles list
fba profiles seed --from myapp-a1b2c3d4 --to myapp-e5f6g7h8
```

---

## CLI

```
fba mcp       start the MCP stdio server (what an agent host launches)
fba doctor    diagnose node, chromium, home, workspace, profiles, index
fba index     build or refresh the code index
fba map       search the code index
fba open      open a url or route and print what the agent would see
fba act       run an action program from JSON
fba skill     manage and replay compiled trajectories
fba profiles  manage per-workspace browser profiles
fba warm      pre-launch the browser (removes cold start from the first call)
fba bench     micro-benchmark the whole pipeline
```

## Configuration

Precedence: explicit overrides → environment → `.fbarc.json` in the workspace →
`config.json` in the FBA home → defaults.

| Variable | Default | |
| --- | --- | --- |
| `FBA_WORKSPACE` | git root of cwd | Workspace whose profile and code index are used |
| `FBA_HOME` | `~/.faster-browser-agent` | Profiles, skills and indexes |
| `FBA_CHROMIUM_PATH` | auto-detected | Browser executable |
| `FBA_HEADLESS` | `true` | |
| `FBA_BASE_URL` | inferred from source | Dev-server origin for route deep-links |
| `FBA_BLOCKING` | `true` | Abort images/media/fonts/analytics |
| `FBA_MAX_NODES` | `300` | Snapshot node cap |
| `FBA_TIMEOUT_MS` | `15000` | |
| `FBA_LOG_LEVEL` | `warn` | All logging goes to stderr |

## Library use

The MCP server is one consumer of the library, not the library itself:

```ts
import { createAgentBrowser } from 'faster-browser-agent';

const { pool, executor, indexer, shutdown } = await createAgentBrowser();
const session = await pool.acquire();
await session.goto('http://localhost:3000/settings');
const observation = await session.observe();
await shutdown();
```

---

## Limitations

Worth knowing before you adopt it:

- **Cross-origin iframes are not traversed.** The snapshot notes their presence but does not
  descend into them.
- **The code index is regex-based, not a parser.** That is what makes it fast and
  framework-agnostic; it also means unusual routing setups may be missed. Implausible
  extractions are filtered out rather than guessed at, so a miss shows up as a missing
  route, never a wrong one.
- **Settle detection is a heuristic.** A page that polls on a short interval never goes
  quiet and will hit the timeout cap instead.
- **Chromium only.** Firefox and WebKit are not wired up.
- **No screenshots.** Deliberate — but if your task is genuinely visual, this is the wrong
  tool for that part of it.

## Development

```bash
npm install
npm run build
npm test          # 269 tests, including real-browser integration tests
npm run typecheck
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design rationale of each layer.

## License

MIT

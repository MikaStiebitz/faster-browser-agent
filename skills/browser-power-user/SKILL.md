---
name: browser-power-user
description: Drive a web app efficiently — navigate, inspect, and configure pages with deep tab/settings hierarchies. Use whenever a task involves opening, reading, clicking through, filling in, or verifying something in a browser, especially admin panels, settings screens, dashboards and multi-tab configuration UIs. Also use when a browser flow is being repeated, or when several agents each need their own logged-in browser state.
---

# Browser power user

The `browser_*` tools are coarse-grained on purpose. The expensive resource is **your
round trips**, not the browser. One call that does ten things beats ten calls.

## The doctrine

1. **Look it up before you click it.** `browser_map` reads the app's source code — route
   table, tab definitions, config schema. Reaching a settings sub-tab is a *lookup*,
   not an exploration.
2. **Deep-link, never navigate by clicking.** `browser_open {route: "settings/advanced"}`
   goes straight there. Clicking through three levels costs three round trips and three
   snapshots for the same result.
3. **Batch every action.** `browser_act` takes a *program*, not one action. Chain the
   whole sequence with `assert` guards and read one result.
4. **Fill forms in one call.** `browser_form` sets many fields at once, by human label.
5. **Do not screenshot.** The text snapshot is complete and ~20x cheaper. Only reach for
   a screenshot when the answer is genuinely visual (canvas, chart rendering, layout bugs).
6. **Save what you'll repeat.** `browser_skill` replays a known flow with zero model calls.

## Typical flow

```
browser_map      { query: "smtp" }              → the route + which tab the field lives in
browser_open     { route: "settings/network" }  → deep link, one hop
browser_form     { tabPath: ["Network","SMTP"],
                   fields: { "SMTP host": "smtp.acme.io",
                             "SMTP port": 587,
                             "Encryption": "TLS",
                             "Use TLS": true },
                   submit: true }               → tab switch + 4 fields + save + verify
```

Three calls for something that is commonly done in twenty.

## `browser_act` — write real programs

Guards belong *inside* the program. Come back to the model only when something diverges.

```json
{"steps": [
  {"do": "selectTab", "path": ["Settings", "Advanced"]},
  {"do": "expand",    "target": {"name": "Experimental features"}},
  {"do": "check",     "target": {"label": "Enable feature A"}, "checked": true},
  {"do": "click",     "target": {"role": "button", "name": "Save"}},
  {"do": "assert",    "text": "Saved"}
]}
```

- `selectTab` walks a tab path directly — use it instead of hand-clicking tabs.
- `expand` is a no-op when the section is already open, so it is always safe to include.
- A failing `assert` stops the program and tells you exactly which step diverged.
- `onFailure: "retry"` re-resolves and retries once — good for flaky, animated UIs.

## Targeting elements

Pass whatever you know; resolution walks a fallback chain and heals itself:

```
{"ref": "e42"}                              from the last snapshot — fastest
{"testId": "smtp-host"}                     stable across redesigns
{"label": "SMTP port"}                      how a human describes it
{"role": "button", "name": "Save"}          precise and readable
{"text": "Delete", "within": "e17"}         scoped to a dialog/panel
```

A stale `ref` does **not** fail the step if the element is still findable by name. If a
target is ambiguous the error lists the candidates — pick one and add `nth`, rather than
guessing twice.

## Reading pages

`browser_snapshot` returns a **diff** by default — only what changed since your last look.
Ask for `full: true` after a navigation or when you have lost track.

Snapshots are scoped and compressed: viewport-first, modal-scoped when a dialog is open,
collapsed sections shown as one line, repeated rows folded into `… +37 similar`. If you
need something that was compressed away:

- `scope: "page"` for the whole document
- `filter: "smtp"` to keep only matching controls
- `expandCollapsed: true` to open up collapsed sections
- `root: "<ref>"` to zoom into one panel

Prefer `filter` over `scope: "page"`. It is far cheaper and usually answers the question.

## Finding things

`browser_find {query: "SMTP port"}` merges live page candidates with source-code matches
and tells you **how to reach** each one — which tab path, and whether a deep link exists.
Use it instead of taking a full snapshot to hunt for a field.

## Repeating a flow

```
browser_act   { steps: [...], record: "configure-smtp" }   → runs and saves
browser_skill { action: "replay", name: "configure-smtp",
                params: { host: "smtp.acme.io" } }         → zero model calls
```

Replay verifies itself against the assertions recorded with it. If the UI changed, it
fails fast and says so — then drive it manually and re-record.

## Parallel agents and browser state

Every git workspace gets its own browser profile: separate cookies, separate logins, no
cross-talk. Working in a worktree is automatically isolated.

- `browser_session {action: "profiles"}` — see the profiles and which are in use
- `browser_session {action: "seed", from: "<id>", to: "<id>"}` — copy a logged-in state
  into a fresh worktree instead of redoing an OAuth dance
- `browser_session {action: "warm"}` — pre-launch the browser so the first real call
  doesn't pay cold-start

## Extracting data

If the page fetched the data over an API, take the API:

```
browser_extract {}                                    → lists endpoints the page called
browser_extract { endpoint: "GET /api/users?page" }   → replays it with the page's cookies
```

No rendering, no snapshot. For DOM extraction, pass a `schema` of field → description
and get structured rows back.

## Anti-patterns

| Don't | Do |
| --- | --- |
| Click through nav to reach a settings page | `browser_open {route}` |
| One `browser_act` per click | One `browser_act` with all the steps |
| Field-by-field form filling | `browser_form` with all fields |
| `scope: "page"` to find one control | `browser_find` or `filter` |
| Screenshot to "see" the page | The text snapshot |
| Re-deriving a flow you already ran | `browser_skill` replay |
| Waiting/sleeping after an action | Nothing — settling is automatic |

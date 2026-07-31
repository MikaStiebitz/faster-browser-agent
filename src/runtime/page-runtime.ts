/**
 * The injected page runtime (L1) — `window.__fba`.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS FILE IS SHIPPED (read before editing!)
 * ---------------------------------------------------------------------------
 * The whole runtime lives inside ONE module-scope function, `installFbaRuntime`.
 * We ship it to the browser as a string produced by `Function.prototype.toString()`:
 *
 *     export const PAGE_RUNTIME_SOURCE = `(${installFbaRuntime.toString()})();`;
 *
 * That works only because `tsconfig` targets ES2022 and TypeScript therefore
 * *erases* types without emitting any runtime helper (no `tslib`, no
 * `__decorate`, no `__spreadArray`). The emitted function body is already valid
 * standalone browser JavaScript.
 *
 * Consequences you must respect when editing `installFbaRuntime`:
 *   - it may NOT reference any module-scope identifier or any import;
 *     type-only imports are fine, they vanish at compile time,
 *   - no `enum`, no `namespace`, no decorators, no parameter properties, no
 *     `abstract`/`private` class members, nothing that needs a TS helper,
 *   - every helper must be nested inside the function.
 * Plain functions, `const`/`let`, classes, `async`/`await`, optional chaining,
 * spread and template literals are all safe.
 *
 * Everything below the export is the browser's problem; nothing in here runs in
 * Node.
 */

import type { PageRuntimeApi, RuntimeSnapshot } from '../contracts.js';
import type {
  OverlayInfo,
  Ref,
  SettleOptions,
  SettleResult,
  SnapMeta,
  SnapNode,
  SnapRole,
  SnapState,
  SnapshotOptions,
} from '../types.js';

/**
 * Bumped whenever the injected runtime changes shape. The session layer
 * compares `window.__fba.version` against this to decide whether a page that
 * already has a runtime needs re-injection.
 *
 * KEEP IN SYNC with `const VERSION` inside `installFbaRuntime` — the function
 * cannot reference this constant (see the header comment).
 */
export const RUNTIME_VERSION = '1';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- referenced via toString()
function installFbaRuntime(): void {
  const VERSION = '1';

  const win = window;
  // Re-injection is idempotent within one document; a navigation creates a new
  // JS realm so `win.__fba` is gone and state resets naturally.
  if (win.__fba && win.__fba.version === VERSION) return;

  // -------------------------------------------------------------------------
  // Captured natives.
  //
  // Real-world pages monkey-patch `Array.prototype`, add enumerable properties
  // to `Object.prototype`, and wrap DOM methods (analytics, a11y overlays,
  // framework devtools). We grab everything we need at install time and never
  // use `for...in`, `.hasOwnProperty` or literal-object lookup tables, so a
  // hostile prototype cannot change what we observe. String/Number prototypes
  // are assumed intact — a page that breaks those breaks itself first.
  // -------------------------------------------------------------------------
  const doc = win.document;
  const MapCtor = Map;
  const SetCtor = Set;
  const WeakMapCtor = WeakMap;
  const PromiseCtor = Promise;
  const arrSort = Array.prototype.sort;
  const objAssign = Object.assign;

  const elProto = Element.prototype;
  const nodeProto = Node.prototype;
  const elGetAttribute = elProto.getAttribute;
  const elHasAttribute = elProto.hasAttribute;
  const elSetAttribute = elProto.setAttribute;
  const elRemoveAttribute = elProto.removeAttribute;
  const elMatches = elProto.matches;
  const elClosest = elProto.closest;
  const elQsa = elProto.querySelectorAll;
  const elQs = elProto.querySelector;
  const elGetBoundingClientRect = elProto.getBoundingClientRect;
  const elGetClientRects = elProto.getClientRects;
  const elScrollIntoView = elProto.scrollIntoView;
  const nodeContains = nodeProto.contains;
  const docQsa = Document.prototype.querySelectorAll;
  const docQs = Document.prototype.querySelector;
  const docGetElementById = Document.prototype.getElementById;
  const docCreateTreeWalker = Document.prototype.createTreeWalker;
  const getComputedStyleNative = win.getComputedStyle;
  const setTimeoutNative = win.setTimeout;
  const rafNative = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame : null;

  /** `Element.checkVisibility` is a single native call that answers what would
   *  otherwise cost several `getComputedStyle` walks. Chromium >=105 has it. */
  type CheckVisibilityFn = (
    this: Element,
    options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean; contentVisibilityAuto?: boolean },
  ) => boolean;
  const elProtoLoose = elProto as unknown as { checkVisibility?: CheckVisibilityFn };
  const checkVisibilityNative: CheckVisibilityFn | null =
    typeof elProtoLoose.checkVisibility === 'function' ? elProtoLoose.checkVisibility : null;

  // IDL reflections are ~2x cheaper than getAttribute/hasAttribute and we call
  // these once per visited element, which on a 10k-node page is the difference
  // between a 15ms and a 25ms snapshot. They reflect only the element's own
  // content attribute, which is exactly right for a top-down walk: an inert or
  // aria-hidden ancestor has already been rejected before we get here.
  const hasAriaHiddenProp = 'ariaHidden' in elProto;
  const hasRoleProp = 'role' in elProto;
  const hasInertProp = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;

  const nowMs: () => number = (function () {
    const p = win.performance;
    if (p && typeof p.now === 'function') {
      return function () {
        return p.now();
      };
    }
    return function () {
      return Date.now();
    };
  })();

  // TreeWalker/NodeFilter constants inlined so a patched global `NodeFilter`
  // cannot redirect the walk.
  const SHOW_ELEMENT = 0x1;
  const FILTER_ACCEPT = 1;
  const FILTER_REJECT = 2;

  const REF_ATTR = 'data-fba';
  const REF_PATTERN = /^e[0-9]+$/;

  // -------------------------------------------------------------------------
  // Tiny utilities (no Array.prototype dependency)
  // -------------------------------------------------------------------------

  function push<T>(list: T[], value: T): void {
    // Index assignment cannot be intercepted the way `.push` can.
    list[list.length] = value;
  }

  function sortBy<T>(list: T[], cmp: (a: T, b: T) => number): void {
    try {
      arrSort.call(list, cmp as (a: unknown, b: unknown) => number);
    } catch {
      /* a comparator throwing must never break a snapshot */
    }
  }

  function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - 1)) + '…';
  }

  function norm(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  function lower(text: string): string {
    return text.toLowerCase();
  }

  function tokens(text: string): string[] {
    const raw = lower(text).split(/[^a-z0-9]+/);
    const out: string[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const t = raw[i];
      if (t) push(out, t);
    }
    return out;
  }

  function attr(el: Element, name: string): string | null {
    try {
      return elGetAttribute.call(el, name);
    } catch {
      return null;
    }
  }

  function hasAttr(el: Element, name: string): boolean {
    try {
      return elHasAttribute.call(el, name);
    } catch {
      return false;
    }
  }

  function matches(el: Element, selector: string): boolean {
    try {
      return elMatches.call(el, selector);
    } catch {
      return false;
    }
  }

  function closestEl(el: Element, selector: string): Element | null {
    try {
      return elClosest.call(el, selector);
    } catch {
      return null;
    }
  }

  function contains(ancestor: Node, node: Node): boolean {
    try {
      return nodeContains.call(ancestor, node);
    } catch {
      return false;
    }
  }

  function qsa(root: Document | Element, selector: string, cap: number): Element[] {
    const out: Element[] = [];
    try {
      const list = root === doc ? docQsa.call(doc, selector) : elQsa.call(root as Element, selector);
      const n = list.length < cap ? list.length : cap;
      for (let i = 0; i < n; i += 1) {
        const item = list[i];
        if (item) push(out, item);
      }
    } catch {
      /* invalid selector on an exotic document — return what we have */
    }
    return out;
  }

  function qs(root: Document | Element, selector: string): Element | null {
    try {
      return root === doc ? docQs.call(doc, selector) : elQs.call(root as Element, selector);
    } catch {
      return null;
    }
  }

  function rectOf(el: Element): DOMRect | null {
    try {
      return elGetBoundingClientRect.call(el);
    } catch {
      return null;
    }
  }

  function hasBoxes(el: Element): boolean {
    try {
      return elGetClientRects.call(el).length > 0;
    } catch {
      return false;
    }
  }

  function viewportSize(): { w: number; h: number } {
    // `innerWidth/Height` first, deliberately: in quirks mode (no doctype)
    // `documentElement.clientHeight` is the *content* height, not the viewport,
    // which silently disables every viewport-scoping optimisation below.
    const de = doc.documentElement;
    const w = win.innerWidth || (de && de.clientWidth) || 1024;
    const h = win.innerHeight || (de && de.clientHeight) || 768;
    return { w, h };
  }

  // -------------------------------------------------------------------------
  // Ref registry
  // -------------------------------------------------------------------------

  let refCounter = 0;
  let refToEl = new MapCtor<string, Element>();

  function refFor(el: Element): string {
    const existing = attr(el, REF_ATTR);
    if (existing && REF_PATTERN.test(existing)) {
      if (refToEl.get(existing) !== el) refToEl.set(existing, el);
      // Keep the counter ahead of anything already on the page so a later mint
      // cannot collide with an attribute that survived a soft reset.
      const n = parseInt(existing.slice(1), 10);
      if (n > refCounter) refCounter = n;
      return existing;
    }
    refCounter += 1;
    const ref = 'e' + refCounter;
    try {
      elSetAttribute.call(el, REF_ATTR, ref);
    } catch {
      /* read-only DOM (e.g. inside a frozen custom element) — ref still usable
         through the map for this snapshot */
    }
    refToEl.set(ref, el);
    return ref;
  }

  function elForRef(ref: string): Element | null {
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) return null;
    const cached = refToEl.get(ref);
    if (cached && cached.isConnected) return cached;
    // The framework may have recreated the node while preserving attributes.
    const found = qs(doc, '[' + REF_ATTR + '="' + ref + '"]');
    if (found) {
      refToEl.set(ref, found);
      return found;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Role vocabulary
  // -------------------------------------------------------------------------

  const INTERACTIVE = new SetCtor<string>([
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
    'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'file', 'colorpicker',
    'datepicker', 'menuitem', 'treeitem', 'tab',
  ]);

  const CONTAINERS = new SetCtor<string>([
    'tablist', 'tabpanel', 'dialog', 'menu', 'nav', 'form', 'section', 'fieldset',
    'table', 'row', 'list', 'main', 'banner', 'contentinfo', 'region', 'group',
  ]);

  /** Containers that are worth emitting even when they have no name. */
  const LANDMARKS = new SetCtor<string>([
    'nav', 'main', 'banner', 'contentinfo', 'form', 'dialog', 'tablist', 'tabpanel',
    'table', 'list', 'menu', 'fieldset',
  ]);

  const EXPLICIT_ROLES = new MapCtor<string, SnapRole>([
    ['button', 'button'], ['link', 'link'], ['textbox', 'textbox'], ['searchbox', 'searchbox'],
    ['combobox', 'combobox'], ['listbox', 'listbox'], ['option', 'option'], ['checkbox', 'checkbox'],
    ['radio', 'radio'], ['switch', 'switch'], ['slider', 'slider'], ['spinbutton', 'spinbutton'],
    ['menuitem', 'menuitem'], ['menuitemcheckbox', 'menuitem'], ['menuitemradio', 'menuitem'],
    ['treeitem', 'treeitem'], ['tab', 'tab'], ['tablist', 'tablist'], ['tabpanel', 'tabpanel'],
    ['dialog', 'dialog'], ['alertdialog', 'dialog'], ['menu', 'menu'], ['menubar', 'menu'],
    ['navigation', 'nav'], ['form', 'form'], ['search', 'region'], ['group', 'group'],
    ['radiogroup', 'group'], ['toolbar', 'group'], ['table', 'table'], ['grid', 'table'],
    ['treegrid', 'table'], ['rowgroup', 'group'], ['row', 'row'], ['cell', 'cell'],
    ['gridcell', 'cell'], ['columnheader', 'cell'], ['rowheader', 'cell'], ['list', 'list'],
    ['listitem', 'listitem'], ['main', 'main'], ['banner', 'banner'], ['contentinfo', 'contentinfo'],
    ['region', 'region'], ['complementary', 'region'], ['article', 'section'], ['document', 'section'],
    ['application', 'section'], ['figure', 'section'], ['note', 'section'], ['heading', 'heading'],
    ['alert', 'alert'], ['status', 'status'], ['progressbar', 'status'], ['timer', 'status'],
    ['log', 'status'], ['marquee', 'status'], ['tooltip', 'status'], ['meter', 'status'],
    ['img', 'image'], ['image', 'image'], ['presentation', 'generic'], ['none', 'generic'],
    ['generic', 'generic'], ['tree', 'list'], ['feed', 'list'], ['directory', 'list'],
    ['term', 'listitem'], ['definition', 'text'], ['paragraph', 'text'], ['code', 'text'],
    ['emphasis', 'text'], ['strong', 'text'], ['caption', 'text'], ['separator', 'generic'],
    ['scrollbar', 'slider'], ['math', 'text'], ['blockquote', 'text'], ['time', 'text'],
  ]);

  const INPUT_ROLES = new MapCtor<string, SnapRole>([
    ['text', 'textbox'], ['email', 'textbox'], ['url', 'textbox'], ['tel', 'textbox'],
    ['password', 'textbox'], ['search', 'searchbox'], ['checkbox', 'checkbox'], ['radio', 'radio'],
    ['range', 'slider'], ['number', 'spinbutton'], ['file', 'file'], ['color', 'colorpicker'],
    ['date', 'datepicker'], ['time', 'datepicker'], ['datetime-local', 'datepicker'],
    ['month', 'datepicker'], ['week', 'datepicker'], ['submit', 'button'], ['button', 'button'],
    ['reset', 'button'], ['image', 'button'],
  ]);

  const TAG_ROLES = new MapCtor<string, SnapRole>([
    ['button', 'button'], ['summary', 'button'], ['textarea', 'textbox'], ['option', 'option'],
    ['optgroup', 'group'], ['form', 'form'], ['fieldset', 'fieldset'], ['nav', 'nav'],
    ['main', 'main'], ['aside', 'region'], ['section', 'section'], ['article', 'section'],
    ['hgroup', 'section'], ['figure', 'section'], ['search', 'region'], ['dialog', 'dialog'],
    ['details', 'group'], ['ul', 'list'], ['ol', 'list'], ['menu', 'list'], ['dl', 'list'],
    ['li', 'listitem'], ['dt', 'listitem'], ['dd', 'listitem'], ['table', 'table'], ['tr', 'row'],
    ['td', 'cell'], ['th', 'cell'], ['img', 'image'], ['svg', 'image'], ['canvas', 'image'],
    ['iframe', 'iframe'], ['frame', 'iframe'], ['object', 'iframe'], ['embed', 'iframe'],
    ['progress', 'status'], ['meter', 'status'], ['output', 'status'],
    ['h1', 'heading'], ['h2', 'heading'], ['h3', 'heading'], ['h4', 'heading'],
    ['h5', 'heading'], ['h6', 'heading'],
  ]);

  /** Never walked into: no perceivable content for an agent. */
  const SKIP_TAGS = new SetCtor<string>([
    'script', 'style', 'noscript', 'template', 'link', 'meta', 'title', 'head', 'base', 'br', 'hr',
    'source', 'track', 'param', 'map', 'area', 'defs', 'symbol',
  ]);

  /** Inline formatting tags — an element whose only children are these is still
   *  a single piece of text as far as an agent is concerned. */
  const INLINE_TAGS = new SetCtor<string>([
    'b', 'i', 'em', 'strong', 'small', 'span', 'code', 'sub', 'sup', 'u', 'mark', 's', 'abbr',
    'time', 'kbd', 'var', 'samp', 'bdi', 'bdo', 'wbr', 'br',
  ]);

  const TEXTY_TAGS = new SetCtor<string>([
    'p', 'span', 'div', 'li', 'td', 'th', 'label', 'dd', 'dt', 'figcaption', 'blockquote',
    'strong', 'em', 'b', 'i', 'small', 'code', 'pre', 'output', 'time',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'address', 'cite', 'q',
  ]);

  const TESTID_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'];

  function localNameOf(el: Element): string {
    const ln = el.localName;
    return typeof ln === 'string' ? lower(ln) : '';
  }

  function explicitRole(el: Element): SnapRole | null {
    // `el.role` (ARIAMixin) is the cheap reflection of the `role` attribute and
    // this runs once per visited element, so the difference is measurable.
    const raw = hasRoleProp ? (el as unknown as { role: string | null }).role : attr(el, 'role');
    if (!raw) return null;
    // `role` is a token list; the first recognised token wins (ARIA semantics).
    const parts = lower(raw).split(/\s+/);
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      if (!p) continue;
      const mapped = EXPLICIT_ROLES.get(p);
      if (mapped) return mapped;
    }
    return null;
  }

  function computeRole(el: Element, tag: string): SnapRole {
    const explicit = explicitRole(el);
    if (explicit) return explicit;

    if (tag === 'input') {
      const type = lower(attr(el, 'type') || 'text');
      return INPUT_ROLES.get(type) || 'textbox';
    }
    if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      if (hasAttr(el, 'multiple') || (typeof sel.size === 'number' && sel.size > 1)) return 'listbox';
      return 'combobox';
    }
    if (tag === 'a' || tag === 'area') {
      return hasAttr(el, 'href') ? 'link' : 'generic';
    }
    if (tag === 'header' || tag === 'footer') {
      // ARIA: header/footer are landmarks only when not scoped to a sectioning element.
      const scoped = closestEl(el, 'article,aside,main,nav,section');
      if (scoped && scoped !== el) return 'section';
      return tag === 'header' ? 'banner' : 'contentinfo';
    }
    const byTag = TAG_ROLES.get(tag);
    if (byTag) return byTag;
    if (hasAttr(el, 'contenteditable') && lower(attr(el, 'contenteditable') || '') !== 'false') {
      return 'textbox';
    }
    return 'generic';
  }

  // -------------------------------------------------------------------------
  // Accessible name (pragmatic accname subset)
  // -------------------------------------------------------------------------

  /**
   * Bounded text extraction. `textContent` on a card-sized <a> can be kilobytes;
   * we stop as soon as we have enough for a name and never recurse deeply.
   */
  function textOf(el: Element, limit: number): string {
    let out = '';
    function walk(node: Node, depth: number): void {
      if (out.length >= limit || depth > 6) return;
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i += 1) {
        if (out.length >= limit) return;
        const child = kids[i];
        if (!child) continue;
        if (child.nodeType === 3) {
          const data = (child as Text).data;
          if (data) out += data;
          continue;
        }
        if (child.nodeType !== 1) continue;
        const childEl = child as Element;
        const ln = localNameOf(childEl);
        if (SKIP_TAGS.has(ln)) continue;
        if (lower(attr(childEl, 'aria-hidden') || '') === 'true') continue;
        if (hasAttr(childEl, 'hidden')) continue;
        if (ln === 'img') {
          const alt = attr(childEl, 'alt');
          if (alt) out += ' ' + alt;
          continue;
        }
        if (ln === 'input') {
          const t = lower(attr(childEl, 'type') || '');
          if (t === 'submit' || t === 'button' || t === 'reset') {
            const v = attr(childEl, 'value');
            if (v) out += ' ' + v;
          }
          continue;
        }
        walk(childEl, depth + 1);
      }
    }
    try {
      walk(el, 0);
    } catch {
      /* exotic node graph — keep what we collected */
    }
    return norm(out);
  }

  function labelledByText(el: Element, limit: number): string {
    const ids = attr(el, 'aria-labelledby');
    if (!ids) return '';
    const parts = norm(ids).split(' ');
    let out = '';
    for (let i = 0; i < parts.length && i < 6; i += 1) {
      const id = parts[i];
      if (!id) continue;
      let target: Element | null = null;
      try {
        target = docGetElementById.call(doc, id);
      } catch {
        target = null;
      }
      if (!target) continue;
      const label = attr(target, 'aria-label') || textOf(target, limit);
      if (label) out += (out ? ' ' : '') + label;
      if (out.length >= limit) break;
    }
    return norm(out);
  }

  /** Label association for form controls, using the native `labels` list first. */
  function labelText(el: Element, limit: number): string {
    const loose = el as unknown as { labels?: ArrayLike<Element> | null };
    const labels = loose.labels;
    if (labels && labels.length) {
      let out = '';
      for (let i = 0; i < labels.length && i < 3; i += 1) {
        const lab = labels[i];
        if (!lab) continue;
        const own = attr(lab, 'aria-label') || textOf(lab, limit);
        if (own) out += (out ? ' ' : '') + own;
      }
      if (out) return norm(out);
    }
    const wrapping = closestEl(el, 'label');
    if (wrapping) {
      const own = attr(wrapping, 'aria-label');
      if (own) return norm(own);
      const text = textOf(wrapping, limit);
      if (text) return text;
    }
    // Some design systems wire labels with aria-describedby-ish patterns.
    const id = attr(el, 'id');
    if (id) {
      const escaped = id.replace(/["\\]/g, '\\$&');
      const forLabel = qs(doc, 'label[for="' + escaped + '"]');
      if (forLabel) {
        const text = attr(forLabel, 'aria-label') || textOf(forLabel, limit);
        if (text) return norm(text);
      }
    }
    return '';
  }

  const NAME_FROM_CONTENT = new SetCtor<string>([
    'button', 'link', 'tab', 'menuitem', 'option', 'treeitem', 'heading', 'cell', 'listitem',
    'switch', 'checkbox', 'radio', 'text', 'alert', 'status',
  ]);

  function accName(el: Element, role: SnapRole, tag: string, cap: number): string {
    // Deliberately cheap: no getComputedStyle, no recursive accname resolution.
    const budget = cap * 2 + 16;
    try {
      const byLabelledBy = labelledByText(el, budget);
      if (byLabelledBy) return truncate(byLabelledBy, cap);

      const ariaLabel = attr(el, 'aria-label');
      if (ariaLabel && norm(ariaLabel)) return truncate(norm(ariaLabel), cap);

      const isControl = tag === 'input' || tag === 'select' || tag === 'textarea' || role === 'textbox';
      if (isControl) {
        const byLabel = labelText(el, budget);
        if (byLabel) return truncate(byLabel, cap);
      }

      if (CONTAINERS.has(role) && role !== 'cell' && role !== 'listitem') {
        return truncate(containerName(el, tag, budget), cap);
      }

      if (NAME_FROM_CONTENT.has(role)) {
        const text = textOf(el, budget);
        if (text) return truncate(text, cap);
      }

      const placeholder = attr(el, 'placeholder');
      if (placeholder && norm(placeholder)) return truncate(norm(placeholder), cap);

      const title = attr(el, 'title');
      if (title && norm(title)) return truncate(norm(title), cap);

      const alt = attr(el, 'alt');
      if (alt && norm(alt)) return truncate(norm(alt), cap);

      if (tag === 'input') {
        const type = lower(attr(el, 'type') || '');
        if (type === 'button' || type === 'submit' || type === 'reset') {
          const value = attr(el, 'value');
          if (value && norm(value)) return truncate(norm(value), cap);
        }
      }

      const nameAttr = attr(el, 'name');
      if (nameAttr && norm(nameAttr)) return truncate(norm(nameAttr), cap);

      if (role === 'iframe') {
        const src = attr(el, 'src');
        if (src) return truncate(src, cap);
      }
    } catch {
      /* a broken node must not fail the snapshot */
    }
    return '';
  }

  /** Containers get a *label*, never their whole text — that is the token win. */
  function containerName(el: Element, tag: string, budget: number): string {
    if (tag === 'fieldset') {
      const legend = qs(el, 'legend');
      if (legend) {
        const t = textOf(legend, budget);
        if (t) return t;
      }
    }
    if (tag === 'details') {
      const summary = qs(el, 'summary');
      if (summary) {
        const t = textOf(summary, budget);
        if (t) return t;
      }
    }
    if (tag === 'table') {
      const caption = qs(el, 'caption');
      if (caption) {
        const t = textOf(caption, budget);
        if (t) return t;
      }
    }
    const heading = qs(el, 'h1,h2,h3,h4,h5,h6,[role="heading"]');
    if (heading && contains(el, heading)) {
      const t = textOf(heading, budget);
      if (t) return t;
    }
    const title = attr(el, 'title');
    if (title && norm(title)) return norm(title);
    const nameAttr = attr(el, 'name');
    if (nameAttr && norm(nameAttr)) return norm(nameAttr);
    const id = attr(el, 'id');
    if (id && norm(id)) return norm(id);
    return '';
  }

  // -------------------------------------------------------------------------
  // Value / state / meta
  // -------------------------------------------------------------------------

  const VALUE_CAP = 120;

  function valueOf(el: Element, role: SnapRole, tag: string): string {
    try {
      if (tag === 'input') {
        const input = el as HTMLInputElement;
        const type = lower(attr(el, 'type') || 'text');
        if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit' || type === 'reset') {
          return '';
        }
        if (type === 'file') {
          const files = input.files;
          if (!files || files.length === 0) return '';
          let out = '';
          for (let i = 0; i < files.length && i < 3; i += 1) {
            const f = files[i];
            if (f) out += (out ? ', ' : '') + f.name;
          }
          return truncate(out, VALUE_CAP);
        }
        const raw = typeof input.value === 'string' ? input.value : '';
        if (type === 'password') {
          // Never leak secrets into a model context; the length is what an agent
          // actually needs to reason about ("did my typing land?").
          return raw ? '••••(' + raw.length + ')' : '';
        }
        return truncate(raw, VALUE_CAP);
      }
      if (tag === 'textarea') {
        const ta = el as HTMLTextAreaElement;
        return truncate(typeof ta.value === 'string' ? ta.value : '', VALUE_CAP);
      }
      if (tag === 'select') {
        const sel = el as HTMLSelectElement;
        const opts = sel.selectedOptions;
        let out = '';
        if (opts && opts.length) {
          for (let i = 0; i < opts.length && i < 5; i += 1) {
            const o = opts[i];
            if (o) out += (out ? ', ' : '') + norm(o.label || o.text || o.value || '');
          }
        }
        return truncate(out, VALUE_CAP);
      }
      if (role === 'textbox' && hasAttr(el, 'contenteditable')) {
        return truncate(textOf(el, VALUE_CAP + 8), VALUE_CAP);
      }
      if (role === 'slider' || role === 'spinbutton' || role === 'status') {
        const now = attr(el, 'aria-valuenow');
        if (now) return truncate(now, VALUE_CAP);
        const loose = el as unknown as { value?: unknown };
        if (typeof loose.value === 'number') return String(loose.value);
      }
    } catch {
      /* value getters can throw on custom elements */
    }
    return '';
  }

  function ariaBool(el: Element, name: string): boolean | undefined {
    const raw = attr(el, name);
    if (raw === null) return undefined;
    const v = lower(raw);
    if (v === 'true') return true;
    if (v === 'false') return false;
    return undefined;
  }

  function stateOf(
    el: Element,
    role: SnapRole,
    tag: string,
    inViewport: boolean,
    trackOffscreen: boolean,
  ): SnapState {
    const state: SnapState = {};
    try {
      const isFormControl =
        tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' ||
        tag === 'fieldset' || tag === 'optgroup' || tag === 'option';

      // `:disabled` covers the fieldset[disabled] ancestor case in one native call.
      const ariaDisabled = ariaBool(el, 'aria-disabled');
      if (ariaDisabled === true || (isFormControl && matches(el, ':disabled'))) state.disabled = true;

      if (isFormControl && matches(el, ':read-only') && (tag === 'input' || tag === 'textarea')) {
        if (hasAttr(el, 'readonly')) state.readonly = true;
      } else if (ariaBool(el, 'aria-readonly') === true) {
        state.readonly = true;
      }

      if (ariaBool(el, 'aria-required') === true || (isFormControl && matches(el, ':required'))) {
        state.required = true;
      }

      const ariaInvalid = attr(el, 'aria-invalid');
      if (ariaInvalid !== null && lower(ariaInvalid) !== 'false') {
        state.invalid = true;
      } else if ((tag === 'input' || tag === 'select' || tag === 'textarea') && matches(el, ':invalid')) {
        state.invalid = true;
      }

      if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitem' || role === 'option') {
        const ariaChecked = attr(el, 'aria-checked');
        if (ariaChecked !== null) {
          const v = lower(ariaChecked);
          if (v === 'mixed') state.checked = 'mixed';
          else if (v === 'true') state.checked = true;
          else if (v === 'false') state.checked = false;
        } else if (tag === 'input') {
          const input = el as HTMLInputElement;
          if (input.indeterminate) state.checked = 'mixed';
          else state.checked = input.checked === true;
        }
      }

      if (role === 'option' && tag === 'option') {
        state.selected = (el as HTMLOptionElement).selected === true;
      } else {
        const ariaSelected = ariaBool(el, 'aria-selected');
        if (ariaSelected !== undefined) state.selected = ariaSelected;
        else if (role === 'tab' && looksActive(el)) state.selected = true;
      }

      const ariaExpanded = ariaBool(el, 'aria-expanded');
      if (ariaExpanded !== undefined) state.expanded = ariaExpanded;
      else if (tag === 'details') state.expanded = (el as HTMLDetailsElement).open === true;

      if (doc.activeElement === el) state.focused = true;
      if (trackOffscreen && !inViewport) state.offscreen = true;
    } catch {
      /* keep whatever we managed to compute */
    }
    return state;
  }

  /** Last-resort "this looks like the active tab" check used by tabPath. */
  function looksActive(el: Element): boolean {
    if (ariaBool(el, 'aria-selected') === true) return true;
    const dataState = lower(attr(el, 'data-state') || '');
    if (dataState === 'active' || dataState === 'selected' || dataState === 'open') return true;
    const ariaCurrent = attr(el, 'aria-current');
    if (ariaCurrent !== null && lower(ariaCurrent) !== 'false') return true;
    const cls = lower(attr(el, 'class') || '');
    if (!cls) return false;
    return /(^|[\s_-])(is-)?(active|selected|current)([\s_-]|$)/.test(cls);
  }

  function testIdOf(el: Element): string {
    for (let i = 0; i < TESTID_ATTRS.length; i += 1) {
      const name = TESTID_ATTRS[i];
      if (!name) continue;
      const v = attr(el, name);
      if (v) return truncate(norm(v), 80);
    }
    return '';
  }

  function metaOf(el: Element, role: SnapRole, tag: string): SnapMeta {
    const meta: SnapMeta = {};
    try {
      const testId = testIdOf(el);
      if (testId) meta.testId = testId;

      if (role === 'link' || tag === 'a') {
        const link = el as HTMLAnchorElement;
        const href = typeof link.href === 'string' ? link.href : attr(el, 'href') || '';
        if (href) meta.href = truncate(href, 300);
      }

      const placeholder = attr(el, 'placeholder');
      if (placeholder && norm(placeholder)) meta.placeholder = truncate(norm(placeholder), 80);

      if (tag === 'select') {
        const sel = el as HTMLSelectElement;
        const opts = sel.options;
        if (opts && opts.length) {
          const labels: string[] = [];
          const shown = opts.length < 20 ? opts.length : 20;
          for (let i = 0; i < shown; i += 1) {
            const o = opts[i];
            if (o) push(labels, truncate(norm(o.label || o.text || o.value || ''), 60));
          }
          meta.options = labels;
          if (opts.length > shown) meta.truncated = opts.length - shown;
        }
      } else if (role === 'combobox' || role === 'listbox') {
        const listId = attr(el, 'list') || attr(el, 'aria-controls');
        if (listId) {
          let host: Element | null = null;
          try {
            host = docGetElementById.call(doc, listId);
          } catch {
            host = null;
          }
          if (host) {
            const items = qsa(host, 'option,[role="option"]', 20);
            if (items.length) {
              const labels: string[] = [];
              for (let i = 0; i < items.length; i += 1) {
                const item = items[i];
                if (item) push(labels, truncate(textOf(item, 64) || attr(item, 'value') || '', 60));
              }
              meta.options = labels;
            }
          }
        }
      }

      if (role === 'image') {
        const desc = attr(el, 'alt') || attr(el, 'aria-label') || attr(el, 'title') || '';
        if (desc && norm(desc)) meta.desc = truncate(norm(desc), 80);
      }
    } catch {
      /* partial meta is better than none */
    }
    return meta;
  }

  function isEmpty(obj: object): boolean {
    for (const key of Object.keys(obj)) {
      if (key) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  /** Budgeted getComputedStyle: it is the single most expensive DOM call we make. */
  let styleBudget = 0;
  let styleCache = new WeakMapCtor<Element, CSSStyleDeclaration | null>();

  function styleOf(el: Element): CSSStyleDeclaration | null {
    const cached = styleCache.get(el);
    if (cached !== undefined) return cached;
    if (styleBudget <= 0) return null;
    styleBudget -= 1;
    let computed: CSSStyleDeclaration | null = null;
    try {
      computed = getComputedStyleNative.call(win, el);
    } catch {
      computed = null;
    }
    styleCache.set(el, computed);
    return computed;
  }

  const INLINE_HIDDEN = /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\s|;|$))/i;

  /**
   * Visibility check ordered cheapest-first.
   *
   * `Element.checkVisibility` answers display/visibility/opacity/content-visibility
   * in one native call, including ancestors. Its one blind spot for us is
   * `display: contents` (no box => reported invisible) which real layouts use for
   * pass-through wrappers, so when it says "no" we spend ONE getComputedStyle to
   * distinguish `contents` from genuinely hidden. That extra call only ever
   * happens on the root of a rejected subtree, so it stays bounded.
   */
  function isVisible(el: Element): boolean {
    const ariaHidden = hasAriaHiddenProp
      ? (el as unknown as { ariaHidden: string | null }).ariaHidden
      : attr(el, 'aria-hidden');
    if (ariaHidden && lower(ariaHidden) === 'true') return false;
    if (hasInertProp) {
      if ((el as unknown as { inert?: boolean }).inert === true) return false;
    } else if (hasAttr(el, 'inert')) {
      return false;
    }

    if (checkVisibilityNative) {
      // `hidden` and inline display/visibility/opacity are all subsumed by
      // checkVisibility, so we do not pay for those attribute probes here.
      let ok = false;
      try {
        ok = checkVisibilityNative.call(el, {
          checkOpacity: true,
          checkVisibilityCSS: true,
          contentVisibilityAuto: true,
        });
      } catch {
        ok = hasBoxes(el);
      }
      if (ok) return true;
      const computed = styleOf(el);
      return computed ? computed.display === 'contents' : false;
    }

    // Fallback path for engines without checkVisibility.
    if (hasAttr(el, 'hidden')) return false;
    const inlineStyle = attr(el, 'style');
    if (inlineStyle && INLINE_HIDDEN.test(inlineStyle)) return false;
    if (hasBoxes(el)) {
      const computed = styleOf(el);
      if (!computed) return true;
      if (computed.visibility === 'hidden' || computed.visibility === 'collapse') return false;
      if (computed.opacity === '0') return false;
      return true;
    }
    const computed = styleOf(el);
    return computed ? computed.display === 'contents' : false;
  }

  // -------------------------------------------------------------------------
  // Overlay detection
  // -------------------------------------------------------------------------

  interface OverlayHit {
    el: Element;
    kind: OverlayInfo['kind'];
    /** Modal overlays own the screen, so the tree is scoped to them. */
    modal: boolean;
  }

  /**
   * Everything a snapshot needs to know about the document outside the tree
   * walk, gathered in ONE querySelectorAll.
   *
   * Overlay detection, tab paths and notes used to run eight document-wide
   * selector scans between them; on a 7k-element page that alone cost more than
   * the entire DOM walk. Chromium's selector matching is fast but it is still
   * O(document) per scan, so we pay it once and classify in JS.
   */
  interface Probe {
    openDialogs: Element[];
    ariaDialogs: Element[];
    menus: Element[];
    tablists: Element[];
    alerts: Element[];
    frames: Element[];
    forms: Element[];
    navCurrent: Element[];
  }

  const PROBE_SELECTOR =
    'dialog,[aria-modal="true"],[role="dialog"],[role="alertdialog"],[role="menu"],' +
    '[role="listbox"],[popover],[role="tablist"],[role="alert"],[aria-invalid],' +
    'iframe,frame,form,[aria-current]';

  function collectProbe(): Probe {
    const probe: Probe = {
      openDialogs: [], ariaDialogs: [], menus: [], tablists: [],
      alerts: [], frames: [], forms: [], navCurrent: [],
    };
    const hits = qsa(doc, PROBE_SELECTOR, 600);
    for (let i = 0; i < hits.length; i += 1) {
      const el = hits[i];
      if (!el) continue;
      try {
        const tag = localNameOf(el);
        if (tag === 'dialog') {
          if ((el as HTMLDialogElement).open) push(probe.openDialogs, el);
          continue;
        }
        if (tag === 'iframe' || tag === 'frame') {
          push(probe.frames, el);
          continue;
        }
        if (tag === 'form') {
          push(probe.forms, el);
          continue;
        }
        const role = lower(attr(el, 'role') || '');
        if (role === 'dialog' || role === 'alertdialog' || ariaBool(el, 'aria-modal') === true) {
          push(probe.ariaDialogs, el);
          continue;
        }
        if (role === 'tablist') {
          push(probe.tablists, el);
          continue;
        }
        if (role === 'alert') {
          push(probe.alerts, el);
          continue;
        }
        if (role === 'menu' || role === 'listbox' || hasAttr(el, 'popover')) {
          push(probe.menus, el);
          continue;
        }
        const invalid = attr(el, 'aria-invalid');
        if (invalid !== null && lower(invalid) !== 'false') {
          push(probe.alerts, el);
          continue;
        }
        const current = attr(el, 'aria-current');
        if (current !== null && lower(current) !== 'false' && closestEl(el, 'nav,[role="navigation"]')) {
          push(probe.navCurrent, el);
        }
      } catch {
        /* skip unclassifiable node */
      }
    }
    return probe;
  }

  function overlayKindFor(el: Element, role: SnapRole): OverlayInfo['kind'] {
    const explicit = lower(attr(el, 'role') || '');
    if (explicit === 'alertdialog') return 'alertdialog';
    if (explicit === 'menu' || explicit === 'menubar' || role === 'menu') return 'menu';
    if (explicit === 'listbox' && hasAttr(el, 'popover')) return 'popover';
    const cls = lower(attr(el, 'class') || '') + ' ' + lower(attr(el, 'data-side') || '');
    if (/drawer|offcanvas|off-canvas|sidesheet|side-sheet|sidebar/.test(cls)) return 'drawer';
    if (/popover|dropdown|tooltip|flyout/.test(cls)) return 'popover';
    if (hasAttr(el, 'popover')) return 'popover';
    return 'dialog';
  }

  function detectOverlay(probe: Probe): OverlayHit | null {
    try {
      // 1. Native <dialog open> — the topmost one wins.
      const dialogs = probe.openDialogs;
      for (let i = dialogs.length - 1; i >= 0; i -= 1) {
        const el = dialogs[i];
        if (el && isVisible(el)) {
          const isModal = matches(el, ':modal');
          return { el, kind: overlayKindFor(el, 'dialog'), modal: isModal || hasAttr(el, 'aria-modal') };
        }
      }

      // 2. ARIA modals / dialogs.
      const aria = probe.ariaDialogs;
      for (let i = aria.length - 1; i >= 0; i -= 1) {
        const el = aria[i];
        if (!el || !isVisible(el)) continue;
        const rect = rectOf(el);
        if (rect && rect.width < 40 && rect.height < 40) continue;
        return {
          el,
          kind: overlayKindFor(el, 'dialog'),
          modal: ariaBool(el, 'aria-modal') === true || lower(attr(el, 'role') || '') !== '',
        };
      }

      // 3. A big fixed/absolute layer painted over the page (custom modal roots).
      const vp = viewportSize();
      const stack = topElementsAtCenter(vp);
      for (let i = 0; i < stack.length && i < 14; i += 1) {
        const el = stack[i];
        if (!el) continue;
        const ln = localNameOf(el);
        if (ln === 'body' || ln === 'html') break;
        const computed = styleOf(el);
        if (!computed) continue;
        const pos = computed.position;
        if (pos !== 'fixed' && pos !== 'absolute') continue;
        const rect = rectOf(el);
        if (!rect) continue;
        const coverage = (rect.width * rect.height) / (vp.w * vp.h);
        if (coverage <= 0.5) continue;
        return { el, kind: overlayKindFor(el, 'generic'), modal: true };
      }

      // 4. Non-modal popups: open menus / popovers. Reported, not scoped.
      const popups = probe.menus;
      for (let i = popups.length - 1; i >= 0; i -= 1) {
        const el = popups[i];
        if (!el || !isVisible(el)) continue;
        const rect = rectOf(el);
        if (!rect || rect.width < 16 || rect.height < 16) continue;
        return { el, kind: overlayKindFor(el, 'menu'), modal: false };
      }
    } catch {
      /* overlay detection is an optimisation; never fail the snapshot for it */
    }
    return null;
  }

  function topElementsAtCenter(vp: { w: number; h: number }): Element[] {
    const out: Element[] = [];
    try {
      const loose = doc as unknown as { elementsFromPoint?: (x: number, y: number) => Element[] };
      if (typeof loose.elementsFromPoint === 'function') {
        const list = loose.elementsFromPoint(vp.w / 2, vp.h / 2);
        for (let i = 0; i < list.length; i += 1) {
          const item = list[i];
          if (item) push(out, item);
        }
      }
    } catch {
      /* cross-origin or detached document */
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Tab path
  // -------------------------------------------------------------------------

  function depthOf(el: Element): number {
    let d = 0;
    let cur: Element | null = el;
    while (cur && d < 200) {
      cur = cur.parentElement;
      d += 1;
    }
    return d;
  }

  function selectedTabLabel(group: Element, cap: number): string {
    const direct = qs(group, '[role="tab"][aria-selected="true"],[role="tab"][data-state="active"],[aria-current="page"],[aria-current="true"]');
    if (direct) {
      const label = accName(direct, 'tab', localNameOf(direct), cap);
      if (label) return label;
    }
    const tabs = qsa(group, '[role="tab"],a,button', 40);
    for (let i = 0; i < tabs.length; i += 1) {
      const tab = tabs[i];
      if (!tab || !looksActive(tab)) continue;
      const label = accName(tab, 'tab', localNameOf(tab), cap);
      if (label) return label;
    }
    return '';
  }

  function computeTabPath(probe: Probe, cap: number): string[] {
    const path: string[] = [];
    try {
      const groups = probe.tablists;
      const visible: Element[] = [];
      for (let i = 0; i < groups.length; i += 1) {
        const g = groups[i];
        if (g && isVisible(g)) push(visible, g);
      }
      // Outermost first: shallower elements describe the coarser navigation level.
      sortBy(visible, (a, b) => depthOf(a) - depthOf(b));
      for (let i = 0; i < visible.length && path.length < 4; i += 1) {
        const g = visible[i];
        if (!g) continue;
        const label = selectedTabLabel(g, cap);
        if (label && !includesString(path, label)) push(path, label);
      }
      if (path.length === 0) {
        // No tablist: fall back to the current nav item, which plays the same role.
        for (let i = 0; i < probe.navCurrent.length && path.length === 0; i += 1) {
          const current = probe.navCurrent[i];
          if (!current || !isVisible(current)) continue;
          const label = accName(current, 'link', localNameOf(current), cap);
          if (label) push(path, label);
        }
      }
    } catch {
      /* structure detection is advisory */
    }
    return path;
  }

  function includesString(list: string[], value: string): boolean {
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] === value) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  /**
   * A candidate node.
   *
   * The walk fills in only what the *structural* decisions need (role, tier,
   * sometimes the name). Value/state/meta/ref are filled in afterwards by
   * `enrich()`, for surviving nodes only: on a heavy page the walk sees ~2400
   * emittable elements but at most `maxNodes` reach the output, and the
   * enrichment work (`:disabled` matching, testId probing, ref minting) is what
   * dominated the snapshot before this split.
   */
  interface Cand {
    el: Element | null;
    tag: string;
    role: SnapRole;
    name: string;
    /** True when `name` is final and `enrich()` must not recompute it. */
    nameReady: boolean;
    value: string;
    state: SnapState;
    meta: SnapMeta;
    ref: string | undefined;
    children: Cand[];
    parent: Cand | null;
    /** Cap priority; higher survives longer. */
    tier: number;
    order: number;
    /** Set on synthetic repeat-compression placeholders. */
    synthetic: boolean;
    interactive: boolean;
    inViewport: boolean;
    collapsedCount: number;
  }

  function makeCand(el: Element | null, tag: string, role: SnapRole, order: number): Cand {
    return {
      el,
      tag,
      role,
      name: '',
      nameReady: false,
      value: '',
      state: {},
      meta: {},
      ref: undefined,
      children: [],
      parent: null,
      tier: 1,
      order,
      synthetic: false,
      interactive: false,
      inViewport: true,
      collapsedCount: 0,
    };
  }

  function addChild(parent: Cand, child: Cand): void {
    child.parent = parent;
    push(parent.children, child);
  }

  /** Elements walked before we bail out — a hard latency guard on pathological DOMs. */
  const MAX_VISITED = 30000;
  const MAX_TEXT_NODES = 120;

  function isTextBlock(el: Element, tag: string): boolean {
    if (!TEXTY_TAGS.has(tag)) return false;
    if (tag === 'label') {
      // A label's text is already the accessible name of its control; emitting
      // it again doubles the cost of every form for zero information.
      const control = (el as HTMLLabelElement).control;
      if (control) return false;
    }
    const kids = el.children;
    if (kids.length === 0) return true;
    if (kids.length > 4) return false;
    for (let i = 0; i < kids.length; i += 1) {
      const kid = kids[i];
      if (!kid) return false;
      if (!INLINE_TAGS.has(localNameOf(kid))) return false;
    }
    return true;
  }

  function snapshot(options?: SnapshotOptions): RuntimeSnapshot {
    const startedAt = nowMs();
    const opts = options || {};
    const scope = opts.scope || 'viewport';
    const maxNodes = typeof opts.maxNodes === 'number' && opts.maxNodes > 0 ? opts.maxNodes : 300;
    const includeText = opts.includeText !== false;
    const expandCollapsed = opts.expandCollapsed === true;
    const nameCap = typeof opts.nameCap === 'number' && opts.nameCap > 0 ? opts.nameCap : 80;
    const filter = opts.filter ? lower(norm(opts.filter)) : '';

    // Fresh per-snapshot caches; styles change between snapshots.
    styleCache = new WeakMapCtor<Element, CSSStyleDeclaration | null>();
    styleBudget = 300;

    const notes: string[] = [];
    const vp = viewportSize();
    const probe = collectProbe();

    let rootEl: Element | null = doc.body || doc.documentElement;
    let overlay: OverlayHit | null = null;
    let overlayInfo: OverlayInfo | undefined;

    if (scope === 'region' && opts.root) {
      const regionEl = elForRef(opts.root);
      if (regionEl) rootEl = regionEl;
      else push(notes, 'region root ' + opts.root + ' is gone; snapshotting the page');
    } else {
      overlay = detectOverlay(probe);
      if (overlay) {
        const ref = refFor(overlay.el);
        const name = accName(overlay.el, 'dialog', localNameOf(overlay.el), nameCap);
        overlayInfo = { kind: overlay.kind, ref, name: name || undefined };
        if (overlay.modal) {
          rootEl = overlay.el;
          push(notes, 'page behind ' + overlay.kind + ' not shown');
        }
      }
    }

    if (!rootEl) {
      return {
        url: win.location.href,
        title: doc.title || '',
        tree: { role: 'section' },
        stats: { interactive: 0, emitted: 0, elided: 0, captureMs: Math.round((nowMs() - startedAt) * 10) / 10 },
        notes: ['document has no body'],
      };
    }

    const trackOffscreen = scope !== 'viewport';
    const clipToViewport = scope === 'viewport';

    const rootRole = computeRole(rootEl, localNameOf(rootEl));
    const root = makeCand(rootEl, localNameOf(rootEl), rootRole === 'generic' ? 'section' : rootRole, 0);
    root.tier = 9;
    root.nameReady = true;
    root.name = overlay && overlay.modal
      ? accName(rootEl, root.role, localNameOf(rootEl), nameCap)
      : truncate(norm(doc.title || ''), nameCap);
    if (overlay && overlay.modal) root.ref = refFor(rootEl);

    let interactiveCount = 0;
    let elided = 0;
    let textNodes = 0;
    let visited = 0;
    let truncatedWalk = false;
    let pruneRoot: Element | null = null;

    // The walker's acceptNode does all cheap rejection so that hidden and
    // out-of-scope subtrees are never descended into at all. `pruneRoot` is set
    // by the main loop when it decides a container's children are not worth
    // expanding (collapsed accordion, off-viewport block, text block).
    const walker = docCreateTreeWalker.call(doc, rootEl, SHOW_ELEMENT, {
      acceptNode(node: Node): number {
        visited += 1;
        if (visited > MAX_VISITED) {
          truncatedWalk = true;
          return FILTER_REJECT;
        }
        const el = node as Element;
        if (pruneRoot) {
          if (contains(pruneRoot, el)) return FILTER_REJECT;
          pruneRoot = null;
        }
        const tag = localNameOf(el);
        if (SKIP_TAGS.has(tag)) return FILTER_REJECT;
        if (tag === 'svg') {
          // Icon internals are pure noise; the <svg> itself is handled by the
          // main loop via the sibling ACCEPT below.
          return FILTER_ACCEPT;
        }
        if (!isVisible(el)) return FILTER_REJECT;
        return FILTER_ACCEPT;
      },
    } as NodeFilter);

    const stack: Cand[] = [root];
    const seenText = new SetCtor<string>();
    let order = 0;

    try {
      let node = walker.nextNode();
      while (node) {
        order += 1;
        const el = node as Element;
        try {
          const tag = localNameOf(el);

          // Re-parent: pop until the top of the stack is an ancestor of `el`.
          while (stack.length > 1) {
            const top = stack[stack.length - 1];
            if (top && top.el && contains(top.el, el)) break;
            stack.length -= 1;
          }
          const parent = stack[stack.length - 1] || root;

          if (tag === 'svg') {
            // Emit the icon only when it carries a name; never walk inside it.
            pruneRoot = el;
            const svgName = attr(el, 'aria-label') || attr(el, 'title') || '';
            if (svgName && norm(svgName)) {
              const cand = makeCand(el, tag, 'image', order);
              cand.name = truncate(norm(svgName), nameCap);
              cand.nameReady = true;
              cand.tier = 2;
              addChild(parent, cand);
            }
            node = walker.nextNode();
            continue;
          }

          // Geometry is a forced layout read — by far the most expensive thing
          // we can do per node — so it is computed lazily and at most once.
          let rect: DOMRect | null | undefined;
          const geometry = function (): DOMRect | null {
            if (rect === undefined) rect = rectOf(el);
            return rect;
          };
          let inViewportCache: boolean | undefined;
          const inViewportOf = function (): boolean {
            if (inViewportCache === undefined) {
              const r = geometry();
              inViewportCache = !r
                ? true
                : r.bottom > 0 && r.right > 0 && r.top < vp.h && r.left < vp.w;
            }
            return inViewportCache;
          };

          // Only containers can prune a subtree, so leaves never pay for the
          // clipping read; their own offscreen state is resolved on emit.
          if (clipToViewport && el.childElementCount > 0) {
            const r = geometry();
            if (r && (r.width > 0 || r.height > 0) && !inViewportOf()) {
              pruneRoot = el;
              elided += 1;
              node = walker.nextNode();
              continue;
            }
          }

          let role = computeRole(el, tag);
          if (INTERACTIVE.has(role)) interactiveCount += 1;

          let name = '';
          let nameReady = false;
          const nameOf = function (): string {
            if (!nameReady) {
              nameReady = true;
              name = accName(el, role, tag, nameCap);
            }
            return name;
          };

          // Real apps ship <div> buttons. Probe for click evidence *before*
          // computing a name: names are expensive and most generics are
          // structural noise that will never be emitted.
          if (role === 'generic') {
            const html = el as HTMLElement;
            const clickable =
              typeof html.onclick === 'function' ||
              (typeof html.tabIndex === 'number' && html.tabIndex >= 0);
            if (clickable && nameOf()) {
              if (typeof html.onclick === 'function') {
                role = 'button';
              } else {
                const computed = styleOf(el);
                if (computed && computed.cursor === 'pointer') role = 'button';
              }
              if (role === 'button') interactiveCount += 1;
            }
          }

          const isInteractiveNow = INTERACTIVE.has(role);
          const isContainer = CONTAINERS.has(role);
          const textBlock = includeText && !isInteractiveNow && !isContainer && isTextBlock(el, tag);

          let emit = false;
          let tier = 1;

          if (isInteractiveNow) {
            emit = true;
            tier = clipToViewport || inViewportOf() ? 5 : 3;
          } else if (role === 'heading' || role === 'alert' || role === 'status') {
            emit = true;
            tier = 4;
          } else if (role === 'image' || role === 'iframe') {
            emit = role === 'iframe' || !!nameOf();
            tier = 2;
          } else if (isContainer) {
            emit = LANDMARKS.has(role) || role === 'row' || !!nameOf();
            tier = 4;
          } else if (role === 'listitem' || role === 'cell') {
            // Emitted unconditionally: they are the unit repeat-compression
            // groups on, and an empty one is removed again by pruneEmpty().
            emit = true;
            tier = 3;
            // A compound item's own text is just its children concatenated —
            // printing both doubles the cost of every list and every table.
            if (el.childElementCount > 0) {
              name = '';
              nameReady = true;
            } else {
              // A leaf item's text *is* its content; pruneEmpty() needs it now.
              nameOf();
            }
          } else if (textBlock) {
            // A control's inner text is already its accessible name, so text
            // inside an interactive ancestor is always a duplicate.
            if (!parent.interactive) {
              const text = textOf(el, 300);
              const key = lower(text);
              // Also drop text that is already the enclosing container's name
              // (a <legend>, a card heading re-used as the section label, ...).
              const duplicate = seenText.has(key) || (parent.nameReady && lower(parent.name) === key);
              if (text.length >= 2 && textNodes < MAX_TEXT_NODES && !duplicate) {
                seenText.add(key);
                textNodes += 1;
                role = 'text';
                name = truncate(text, Math.max(nameCap, 160));
                nameReady = true;
                emit = true;
                tier = 1;
              }
            }
            // Either way its children are only inline formatting: do not descend.
            pruneRoot = el;
          }

          if (!emit) {
            node = walker.nextNode();
            continue;
          }

          const cand = makeCand(el, tag, role, order);
          cand.name = name;
          cand.nameReady = nameReady;
          cand.tier = tier;
          cand.interactive = isInteractiveNow;
          cand.inViewport = trackOffscreen ? inViewportOf() : true;

          // Collapsed containers: emit the handle, not the contents.
          if (!expandCollapsed && isContainer && el.childElementCount > 0 && isCollapsed(el, tag, role)) {
            cand.collapsedCount = el.childElementCount;
            elided += el.childElementCount;
            pruneRoot = el;
          }

          addChild(parent, cand);
          push(stack, cand);
        } catch {
          /* one bad node must not abort the walk */
        }
        node = walker.nextNode();
      }
    } catch {
      push(notes, 'DOM walk interrupted; snapshot may be partial');
    }

    if (truncatedWalk) push(notes, 'document too large; walk stopped at ' + MAX_VISITED + ' elements');

    elided += compressRepeats(root);
    if (filter) elided += applyFilter(root, filter, nameCap);
    elided += pruneEmpty(root);

    const capResult = applyCap(root, maxNodes);
    elided += capResult;

    // Only now, on the survivors, do we pay for values, states, metadata and refs.
    enrichTree(root, nameCap, trackOffscreen);
    // The document root is not an addressable target; only an overlay or an
    // explicit region root keeps its ref.
    if (!(overlay && overlay.modal) && scope !== 'region') {
      root.ref = undefined;
      root.state = {};
    }

    const tree = toSnapNode(root);
    const emitted = countNodes(tree);

    // ---- notes (all derived from the single probe scan) --------------------
    try {
      const scopeRoot = rootEl;
      let visibleErrors = 0;
      for (let i = 0; i < probe.alerts.length; i += 1) {
        const e = probe.alerts[i];
        if (e && contains(scopeRoot, e) && isVisible(e)) visibleErrors += 1;
      }
      if (visibleErrors > 0) {
        push(notes, visibleErrors + ' validation error' + (visibleErrors === 1 ? '' : 's'));
      }
      for (let i = 0; i < probe.forms.length; i += 1) {
        const form = probe.forms[i];
        if (!form || !contains(scopeRoot, form)) continue;
        const formName = accName(form, 'form', 'form', nameCap);
        push(notes, 'form detected' + (formName ? ': ' + formName : ''));
        break;
      }
      let frameCount = 0;
      for (let i = 0; i < probe.frames.length; i += 1) {
        const f = probe.frames[i];
        if (f && contains(scopeRoot, f)) frameCount += 1;
      }
      if (frameCount > 0) {
        push(notes, frameCount + ' iframe' + (frameCount === 1 ? '' : 's') + ' not traversed');
      }
    } catch {
      /* notes are optional */
    }

    const tabPath = computeTabPath(probe, nameCap);

    const result: RuntimeSnapshot = {
      url: win.location.href,
      title: doc.title || '',
      tree,
      stats: {
        interactive: interactiveCount,
        emitted,
        elided: elided < 0 ? 0 : elided,
        // performance.now() is sub-microsecond; the raw float would render as
        // "7.7000000001862645ms" in every observation. One decimal is plenty.
        captureMs: Math.round((nowMs() - startedAt) * 10) / 10,
      },
    };
    if (overlayInfo) result.overlay = overlayInfo;
    if (tabPath.length) result.tabPath = tabPath;
    if (notes.length) result.notes = notes;
    return result;
  }

  function isCollapsed(el: Element, tag: string, role: SnapRole): boolean {
    if (ariaBool(el, 'aria-expanded') === false) return true;
    if (tag === 'details' && !(el as HTMLDetailsElement).open) return true;
    if (role === 'tabpanel') {
      // A visible-but-unselected panel happens in CSS-only tab implementations.
      const labelledBy = attr(el, 'aria-labelledby');
      if (labelledBy) {
        let tab: Element | null = null;
        try {
          tab = docGetElementById.call(doc, norm(labelledBy).split(' ')[0] || '');
        } catch {
          tab = null;
        }
        if (tab && ariaBool(tab, 'aria-selected') === false) return true;
      }
      const dataState = lower(attr(el, 'data-state') || '');
      if (dataState === 'inactive' || dataState === 'closed') return true;
    }
    return false;
  }

  /**
   * Fill in everything that is expensive per node and only useful once a node
   * has survived compression, filtering and the size cap.
   */
  function enrich(cand: Cand, nameCap: number, trackOffscreen: boolean): void {
    const el = cand.el;
    if (!el) return;
    try {
      if (!cand.nameReady) {
        cand.name = accName(el, cand.role, cand.tag, nameCap);
        cand.nameReady = true;
      }
      cand.value = valueOf(el, cand.role, cand.tag);
      cand.state = stateOf(el, cand.role, cand.tag, cand.inViewport, trackOffscreen);
      cand.meta = metaOf(el, cand.role, cand.tag);
      if (cand.collapsedCount > 0) {
        cand.meta.collapsed = true;
        cand.meta.truncated = cand.collapsedCount;
        cand.state.expanded = false;
      }
      if (
        cand.interactive || CONTAINERS.has(cand.role) || cand.role === 'image' ||
        cand.role === 'iframe' || cand.role === 'heading' || cand.role === 'alert' ||
        cand.role === 'status'
      ) {
        cand.ref = refFor(el);
      }
    } catch {
      /* a node that cannot be described still keeps its role and name */
    }
  }

  function enrichTree(cand: Cand, nameCap: number, trackOffscreen: boolean): void {
    enrich(cand, nameCap, trackOffscreen);
    const kids = cand.children;
    for (let i = 0; i < kids.length; i += 1) {
      const kid = kids[i];
      if (kid) enrichTree(kid, nameCap, trackOffscreen);
    }
  }

  // -------------------------------------------------------------------------
  // Post-passes: repeat compression, filter, empty pruning, cap
  // -------------------------------------------------------------------------

  function shapeKey(cand: Cand): string {
    let key = cand.role;
    const kids = cand.children;
    const n = kids.length < 8 ? kids.length : 8;
    for (let i = 0; i < n; i += 1) {
      const kid = kids[i];
      if (kid) key += '/' + kid.role;
    }
    if (kids.length > n) key += '/+';
    return key;
  }

  /**
   * Product grids, log tables and option lists are the biggest token sink in a
   * naive snapshot: 200 rows that differ only in their text. We keep the first
   * three of every run of >=6 structurally identical siblings and collapse the
   * rest into one synthetic node. The elided elements still carry `data-fba`
   * attributes, so `find()` can still reach them.
   */
  function compressRepeats(root: Cand): number {
    let dropped = 0;
    const queue: Cand[] = [root];
    let head = 0;
    while (head < queue.length) {
      const cand = queue[head];
      head += 1;
      if (!cand) continue;
      const kids = cand.children;
      for (let i = 0; i < kids.length; i += 1) {
        const kid = kids[i];
        if (kid) push(queue, kid);
      }
      if (kids.length < 6) continue;

      const next: Cand[] = [];
      let i = 0;
      while (i < kids.length) {
        const first = kids[i];
        if (!first) {
          i += 1;
          continue;
        }
        const key = shapeKey(first);
        let runEnd = i + 1;
        while (runEnd < kids.length) {
          const other = kids[runEnd];
          if (!other || shapeKey(other) !== key) break;
          runEnd += 1;
        }
        const runLength = runEnd - i;
        if (runLength >= 6) {
          for (let k = i; k < i + 3; k += 1) {
            const keep = kids[k];
            if (keep) push(next, keep);
          }
          const hiddenCount = runLength - 3;
          const placeholder = makeCand(
            null,
            '',
            cand.role === 'table' || first.role === 'row' ? 'row' : 'listitem',
            first.order,
          );
          placeholder.synthetic = true;
          placeholder.nameReady = true;
          placeholder.name = '… ' + hiddenCount + ' more similar items';
          placeholder.meta.repeated = hiddenCount;
          placeholder.tier = 4;
          placeholder.parent = cand;
          push(next, placeholder);
          dropped += countCands(kids, i + 3, runEnd);
        } else {
          for (let k = i; k < runEnd; k += 1) {
            const keep = kids[k];
            if (keep) push(next, keep);
          }
        }
        i = runEnd;
      }
      cand.children = next;
    }
    return dropped;
  }

  function countCands(list: Cand[], from: number, to: number): number {
    let total = 0;
    for (let i = from; i < to; i += 1) {
      const cand = list[i];
      if (!cand) continue;
      total += 1 + countCands(cand.children, 0, cand.children.length);
    }
    return total;
  }

  /** Filtering happens before enrichment, so it resolves what it needs itself. */
  function candMatchesFilter(cand: Cand, term: string, nameCap: number): boolean {
    const el = cand.el;
    if (el && !cand.nameReady) {
      cand.name = accName(el, cand.role, cand.tag, nameCap);
      cand.nameReady = true;
    }
    if (cand.name && lower(cand.name).indexOf(term) >= 0) return true;
    if (!el) return false;
    try {
      const value = valueOf(el, cand.role, cand.tag);
      if (value && lower(value).indexOf(term) >= 0) return true;
      const testId = testIdOf(el);
      if (testId && lower(testId).indexOf(term) >= 0) return true;
    } catch {
      /* unreadable node cannot match */
    }
    return false;
  }

  /** Keep matching nodes plus the ancestors needed to place them. */
  function applyFilter(root: Cand, term: string, nameCap: number): number {
    let dropped = 0;
    function visit(cand: Cand): boolean {
      const kept: Cand[] = [];
      const kids = cand.children;
      for (let i = 0; i < kids.length; i += 1) {
        const kid = kids[i];
        if (!kid) continue;
        if (visit(kid)) push(kept, kid);
        else dropped += 1 + countCands(kid.children, 0, kid.children.length);
      }
      cand.children = kept;
      return kept.length > 0 || candMatchesFilter(cand, term, nameCap);
    }
    const kids = root.children;
    const kept: Cand[] = [];
    for (let i = 0; i < kids.length; i += 1) {
      const kid = kids[i];
      if (!kid) continue;
      if (visit(kid)) push(kept, kid);
      else dropped += 1 + countCands(kid.children, 0, kid.children.length);
    }
    root.children = kept;
    return dropped;
  }

  /** Nameless structural wrappers that ended up with no content are pure noise. */
  function pruneEmpty(root: Cand): number {
    let dropped = 0;
    function visit(cand: Cand): void {
      const kids = cand.children;
      const kept: Cand[] = [];
      for (let i = 0; i < kids.length; i += 1) {
        const kid = kids[i];
        if (!kid) continue;
        visit(kid);
        const worthless =
          kid.children.length === 0 &&
          !kid.name &&
          !kid.value &&
          !kid.synthetic &&
          kid.collapsedCount === 0 &&
          (CONTAINERS.has(kid.role) || kid.role === 'generic' || kid.role === 'listitem' || kid.role === 'cell') &&
          !INTERACTIVE.has(kid.role);
        if (worthless) dropped += 1;
        else push(kept, kid);
      }
      cand.children = kept;
    }
    visit(root);
    return dropped;
  }

  /**
   * Budget enforcement. Nodes are admitted by priority tier (overlay/root first,
   * then visible interactive, structure, offscreen interactive, images, text),
   * and admitting a node always admits its ancestor chain so the tree stays
   * connected.
   */
  function applyCap(root: Cand, maxNodes: number): number {
    const all: Cand[] = [];
    function flatten(cand: Cand): void {
      push(all, cand);
      const kids = cand.children;
      for (let i = 0; i < kids.length; i += 1) {
        const kid = kids[i];
        if (kid) flatten(kid);
      }
    }
    flatten(root);
    if (all.length <= maxNodes) return 0;

    const ordered: Cand[] = [];
    for (let i = 0; i < all.length; i += 1) {
      const cand = all[i];
      if (cand) push(ordered, cand);
    }
    sortBy(ordered, (a, b) => (b.tier - a.tier) || (a.order - b.order));

    const keep = new SetCtor<Cand>();
    keep.add(root);
    for (let i = 0; i < ordered.length; i += 1) {
      const cand = ordered[i];
      if (!cand || keep.has(cand)) continue;
      if (keep.size >= maxNodes) break;
      const chain: Cand[] = [];
      let cursor: Cand | null = cand;
      while (cursor && !keep.has(cursor)) {
        push(chain, cursor);
        cursor = cursor.parent;
      }
      if (keep.size + chain.length > maxNodes) continue;
      for (let k = 0; k < chain.length; k += 1) {
        const item = chain[k];
        if (item) keep.add(item);
      }
    }

    function prune(cand: Cand): void {
      const kids = cand.children;
      const kept: Cand[] = [];
      for (let i = 0; i < kids.length; i += 1) {
        const kid = kids[i];
        if (kid && keep.has(kid)) {
          push(kept, kid);
          prune(kid);
        }
      }
      cand.children = kept;
    }
    prune(root);
    return all.length - keep.size;
  }

  function toSnapNode(cand: Cand): SnapNode {
    const node: SnapNode = { role: cand.role };
    if (cand.ref) node.ref = cand.ref;
    if (cand.name) node.name = cand.name;
    if (cand.value) node.value = cand.value;
    if (!isEmpty(cand.state)) node.state = cand.state;
    if (!isEmpty(cand.meta)) node.meta = cand.meta;
    const kids = cand.children;
    if (kids.length) {
      const out: SnapNode[] = [];
      for (let i = 0; i < kids.length; i += 1) {
        const kid = kids[i];
        if (kid) push(out, toSnapNode(kid));
      }
      node.children = out;
    }
    return node;
  }

  function countNodes(node: SnapNode): number {
    let total = 1;
    const kids = node.children;
    if (kids) {
      for (let i = 0; i < kids.length; i += 1) {
        const kid = kids[i];
        if (kid) total += countNodes(kid);
      }
    }
    return total;
  }

  // -------------------------------------------------------------------------
  // Settle detection
  // -------------------------------------------------------------------------

  const SETTLE_DEFAULTS = { networkQuietMs: 300, domQuietMs: 200, timeoutMs: 5000 };
  /** A request stuck this long (SSE, hung upload) stops counting as "in flight". */
  const STALE_REQUEST_MS = 15000;
  /** Per-target style/class mutations tolerated before we treat them as animation noise. */
  const STYLE_CHURN_LIMIT = 4;

  let lastMutationAt = nowMs();
  let lastNetworkAt = nowMs();
  let requestSeq = 0;
  const pendingRequests = new MapCtor<number, number>();

  function beginRequest(): number {
    requestSeq += 1;
    pendingRequests.set(requestSeq, nowMs());
    lastNetworkAt = nowMs();
    return requestSeq;
  }

  function endRequest(id: number): void {
    if (pendingRequests.delete(id)) lastNetworkAt = nowMs();
  }

  function inFlightCount(): number {
    const t = nowMs();
    let n = 0;
    pendingRequests.forEach((startedAt, id) => {
      if (t - startedAt < STALE_REQUEST_MS) n += 1;
      else pendingRequests.delete(id);
    });
    return n;
  }

  // --- DOM activity ---------------------------------------------------------
  let churn = new WeakMapCtor<Node, number>();
  let churnWindowStart = nowMs();

  try {
    const observer = new MutationObserver((records) => {
      const t = nowMs();
      // Churn counters are windowed so a page that animates for a second and
      // then does real work is still detected as active.
      if (t - churnWindowStart > 1000) {
        churn = new WeakMapCtor<Node, number>();
        churnWindowStart = t;
      }
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (!record) continue;
        if (record.type === 'attributes') {
          // Our own ref attributes must never look like page activity.
          if (record.attributeName === REF_ATTR) continue;
          if (record.attributeName === 'style' || record.attributeName === 'class') {
            // Spinners, progress bars and CSS transitions rewrite style/class on
            // the same nodes forever; counting those means the page never
            // settles. After STYLE_CHURN_LIMIT hits on one target within the
            // current window they stop refreshing lastMutationAt. Structural and
            // text mutations always count — those change what an agent perceives.
            const target = record.target;
            const seen = (churn.get(target) || 0) + 1;
            churn.set(target, seen);
            if (seen > STYLE_CHURN_LIMIT) continue;
          }
        }
        lastMutationAt = t;
        return;
      }
    });
    observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch {
    /* documents without a MutationObserver still settle via network + readyState */
  }

  // --- Network activity -----------------------------------------------------
  try {
    const originalFetch = win.fetch;
    if (typeof originalFetch === 'function') {
      const patched = function (this: unknown, ...args: unknown[]): Promise<Response> {
        const id = beginRequest();
        let promise: Promise<Response>;
        try {
          promise = (originalFetch as unknown as (...a: unknown[]) => Promise<Response>).apply(win, args);
        } catch (err) {
          endRequest(id);
          throw err;
        }
        if (!promise || typeof promise.then !== 'function') {
          endRequest(id);
          return promise;
        }
        return promise.then(
          (response) => {
            endRequest(id);
            return response;
          },
          (err) => {
            // A rejected fetch must still release the counter, otherwise the
            // page can never be observed as settled again.
            endRequest(id);
            throw err;
          },
        );
      };
      win.fetch = patched as unknown as typeof win.fetch;
    }
  } catch {
    /* CSP-hardened pages may freeze window.fetch */
  }

  try {
    const xhrProto = XMLHttpRequest.prototype;
    const originalSend = xhrProto.send;
    if (typeof originalSend === 'function') {
      xhrProto.send = function (this: XMLHttpRequest, ...args: unknown[]): void {
        const id = beginRequest();
        let done = false;
        const finish = function (): void {
          if (done) return;
          done = true;
          endRequest(id);
        };
        try {
          this.addEventListener('loadend', finish);
        } catch {
          /* older shims */
        }
        try {
          (originalSend as unknown as (...a: unknown[]) => void).apply(this, args);
        } catch (err) {
          finish();
          throw err;
        }
      } as unknown as typeof xhrProto.send;
    }
  } catch {
    /* frozen XHR prototype */
  }

  try {
    // Catches resources we do not patch (scripts, images, beacons, importmaps).
    const po = new PerformanceObserver(() => {
      lastNetworkAt = nowMs();
    });
    po.observe({ type: 'resource', buffered: false });
  } catch {
    /* PerformanceObserver unavailable or 'resource' unsupported */
  }

  function settleOptionsOf(options?: SettleOptions): { networkQuietMs: number; domQuietMs: number; timeoutMs: number } {
    const o = options || {};
    return {
      networkQuietMs: typeof o.networkQuietMs === 'number' ? o.networkQuietMs : SETTLE_DEFAULTS.networkQuietMs,
      domQuietMs: typeof o.domQuietMs === 'number' ? o.domQuietMs : SETTLE_DEFAULTS.domQuietMs,
      timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : SETTLE_DEFAULTS.timeoutMs,
    };
  }

  function isSettled(options?: SettleOptions): boolean {
    const o = settleOptionsOf(options);
    if (doc.readyState !== 'complete') return false;
    if (inFlightCount() > 0) return false;
    const t = nowMs();
    if (t - lastNetworkAt < o.networkQuietMs) return false;
    if (t - lastMutationAt < o.domQuietMs) return false;
    return true;
  }

  function waitSettled(options?: SettleOptions): Promise<SettleResult> {
    const o = settleOptionsOf(options);
    const startedAt = nowMs();
    return new PromiseCtor<SettleResult>((resolve) => {
      const finish = function (settled: boolean, reason: SettleResult['reason']): void {
        const result: SettleResult = { settled, reason, waitedMs: nowMs() - startedAt };
        if (!settled) result.pendingRequests = inFlightCount();
        resolve(result);
      };
      const tick = function (): void {
        try {
          if (isSettled(o)) {
            finish(true, 'quiet');
            return;
          }
          if (nowMs() - startedAt >= o.timeoutMs) {
            finish(false, 'timeout');
            return;
          }
        } catch {
          finish(false, 'timeout');
          return;
        }
        setTimeoutNative.call(win, tick, 50);
      };
      // Observe for two animation frames before the first verdict. `quiet` is
      // otherwise decided against a `lastMutationAt` that predates the caller's
      // action entirely: a click whose re-render lands one microtask later would
      // be reported as settled before it happened. Two frames (~32ms) covers the
      // synchronous + microtask + next-paint reaction that frameworks actually
      // exhibit, without paying the full domQuietMs on every settle.
      if (rafNative) {
        rafNative.call(win, () => {
          rafNative.call(win, () => setTimeoutNative.call(win, tick, 0));
        });
      } else {
        setTimeoutNative.call(win, tick, 16);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Problems
  // -------------------------------------------------------------------------

  const problems: string[] = [];

  function addProblem(text: string): void {
    if (problems.length >= 20) return;
    push(problems, truncate(text, 200));
  }

  function describeValue(value: unknown): string {
    try {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.name + ': ' + value.message;
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      if (typeof value === 'object') {
        const asString = String(value);
        if (asString !== '[object Object]') return asString;
        const keys = Object.keys(value as object);
        return '{' + truncate(keys.join(','), 80) + '}';
      }
      return String(value);
    } catch {
      return '<unserialisable>';
    }
  }

  try {
    win.addEventListener('error', (event: ErrorEvent) => {
      const where = event.filename ? ' (' + event.filename + ':' + event.lineno + ')' : '';
      addProblem('error: ' + (event.message || describeValue(event.error)) + where);
    });
    win.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      addProblem('unhandledrejection: ' + describeValue(event.reason));
    });
  } catch {
    /* no window events available */
  }

  try {
    const console = win.console;
    if (console && typeof console.error === 'function') {
      const originalError = console.error;
      console.error = function (this: unknown, ...args: unknown[]): void {
        try {
          let line = '';
          for (let i = 0; i < args.length && i < 6; i += 1) {
            line += (line ? ' ' : '') + describeValue(args[i]);
          }
          addProblem('console.error: ' + line);
        } catch {
          /* never break the page's logging */
        }
        (originalError as unknown as (...a: unknown[]) => void).apply(console, args);
      } as unknown as typeof console.error;
    }
  } catch {
    /* frozen console */
  }

  // -------------------------------------------------------------------------
  // find()
  // -------------------------------------------------------------------------

  /** Actionable elements: what a target normally refers to. */
  const FIND_SELECTOR_ACTIONABLE =
    'a,button,input,select,textarea,summary,details,option,[role],[onclick],[tabindex],' +
    '[data-testid],[data-test],[data-test-id],[data-cy],[data-qa],[contenteditable]';
  /** Added when the query is text-shaped, where headings and cells matter too. */
  const FIND_SELECTOR_TEXTUAL = 'h1,h2,h3,h4,h5,h6,li,td,th,label';

  /**
   * A pre-normalised query string. `find` compares one needle against thousands
   * of candidates, so normalising and tokenising it once instead of per
   * candidate is the difference between ~90ms and ~10ms on a heavy page.
   */
  interface Needle {
    q: string;
    tokens: string[] | null;
  }

  function needle(text: string): Needle {
    return { q: lower(norm(text)), tokens: null };
  }

  function needleTokens(n: Needle): string[] {
    if (!n.tokens) n.tokens = tokens(n.q);
    return n.tokens;
  }

  function scoreNeedle(n: Needle, candidate: string): number {
    return scoreParts(n, lower(norm(candidate)));
  }

  function scoreParts(n: Needle, c: string): number {
    const q = n.q;
    if (!q || !c) return 0;
    if (c === q) return 1;
    if (c.indexOf(q) === 0) return 0.9;
    if (c.indexOf(q) >= 0) {
      // Length ratio breaks the ancestor/descendant tie: a wrapper whose text
      // merely *contains* the query must not outrank the element that is the
      // query. Without this, `text:` queries always resolve to <body>.
      return 0.8 * (0.7 + 0.3 * (q.length / c.length));
    }
    if (q.indexOf(c) === 0 && c.length >= 3) return 0.75;
    const qt = needleTokens(n);
    const ct = tokens(c);
    if (!qt.length || !ct.length) return 0;
    let hits = 0;
    for (let i = 0; i < qt.length; i += 1) {
      const token = qt[i];
      if (!token) continue;
      for (let k = 0; k < ct.length; k += 1) {
        const other = ct[k];
        if (!other) continue;
        if (other === token || other.indexOf(token) === 0 || token.indexOf(other) === 0) {
          hits += 1;
          break;
        }
      }
    }
    if (!hits) return 0;
    return 0.3 + 0.4 * (hits / qt.length);
  }

  interface FindQuery {
    role?: string;
    name?: string;
    text?: string;
    label?: string;
    placeholder?: string;
    testId?: string;
    within?: Ref;
    limit?: number;
  }

  /** Mirrors `FindCandidate` in contracts.ts (kept local: the runtime is standalone). */
  interface FindCandidate {
    ref: Ref;
    role: string;
    name: string;
    score: number;
    tabPath?: string[];
  }

  /** Label of the tab that controls a given tab panel, if we can find one. */
  function tabLabelForPanel(panel: Element): string {
    const id = attr(panel, 'id');
    if (id) {
      // The controlling tab points at the panel; this is the common direction
      // in real markup and survives panels that carry no aria-labelledby.
      const byControls = doc.querySelector('[aria-controls="' + id.replace(/["\\]/g, '\\$&') + '"]');
      if (byControls) {
        const label = truncate(textOf(byControls, 120), 60);
        if (label) return label;
      }
    }
    const labelledBy = attr(panel, 'aria-labelledby');
    if (labelledBy) {
      const first = labelledBy.split(/\s+/)[0];
      const tab = first ? doc.getElementById(first) : null;
      if (tab) {
        const label = truncate(textOf(tab, 120), 60);
        if (label) return label;
      }
    }
    return truncate(norm(attr(panel, 'aria-label') || ''), 60);
  }

  /**
   * Tab panels enclosing an element, outermost first.
   *
   * Reported per candidate so a search result that lives behind an unopened tab
   * says so. Claiming such an element is reachable "here" would cost the caller
   * a failed interaction plus a recovery round trip.
   */
  function tabPathFor(el: Element): string[] {
    const path: string[] = [];
    try {
      let node: Element | null = el;
      let guard = 0;
      while (node && guard < 300) {
        guard += 1;
        if (attr(node, 'role') === 'tabpanel') {
          const label = tabLabelForPanel(node);
          if (label) push(path, label);
        }
        node = node.parentElement;
      }
    } catch {
      /* structural hint only — never fail a search over it */
    }
    return path.reverse();
  }

  function find(query: FindQuery): FindCandidate[] {
    const out: FindCandidate[] = [];
    try {
      const q = query || {};
      let root: Document | Element = doc;
      if (q.within) {
        const scopeEl = elForRef(q.within);
        if (!scopeEl) return out;
        root = scopeEl;
      }
      styleCache = new WeakMapCtor<Element, CSSStyleDeclaration | null>();
      styleBudget = 60;

      const textual = !!q.text || !!q.label;
      const selector = textual
        ? FIND_SELECTOR_ACTIONABLE + ',' + FIND_SELECTOR_TEXTUAL
        : FIND_SELECTOR_ACTIONABLE;
      const candidates = qsa(root, selector, 8000);
      if (q.text) {
        // Text targets are often plain <div>/<span>, which the actionable
        // selector deliberately excludes.
        const extra = qsa(root, 'p,span,div,strong,em,small,code,dd,dt,figcaption', 4000);
        for (let i = 0; i < extra.length; i += 1) {
          const el = extra[i];
          if (el && el.childElementCount === 0) push(candidates, el);
        }
      }

      const nName = q.name ? needle(q.name) : null;
      const nText = q.text ? needle(q.text) : null;
      const nLabel = q.label ? needle(q.label) : null;
      const nPlaceholder = q.placeholder ? needle(q.placeholder) : null;
      const nTestId = q.testId ? needle(q.testId) : null;

      const wantRole = q.role ? lower(q.role) : '';
      const vp = viewportSize();
      // Two phases: text scoring for every candidate (string work, cheap), then
      // layout-dependent boosts for the shortlist only. Doing visibility and
      // rect reads for all candidates costs ~90ms on a 7k-element page; doing
      // them for the top 40 costs nothing measurable.
      const scored: Array<{ el: Element; role: string; name: string; score: number }> = [];
      const seen = new SetCtor<Element>();

      for (let i = 0; i < candidates.length; i += 1) {
        const el = candidates[i];
        if (!el || seen.has(el)) continue;
        seen.add(el);
        try {
          const tag = localNameOf(el);
          if (SKIP_TAGS.has(tag)) continue;
          const role = computeRole(el, tag);
          if (wantRole && role !== wantRole) continue;

          let total = 0;
          let criteria = 0;
          let name = '';

          if (nTestId) {
            const s = scoreNeedle(nTestId, testIdOf(el));
            if (s <= 0) continue;
            total += s;
            criteria += 1;
          }
          if (nName) {
            name = accName(el, role, tag, 120);
            const s = scoreNeedle(nName, name);
            if (s <= 0) continue;
            total += s;
            criteria += 1;
          }
          if (nLabel) {
            // Only labelable controls have a label; without this guard the
            // <label> element itself scores 1.0 and outranks its own input.
            if (tag !== 'input' && tag !== 'select' && tag !== 'textarea' && !INTERACTIVE.has(role)) continue;
            const s = scoreNeedle(nLabel, labelText(el, 160));
            if (s <= 0) continue;
            total += s;
            criteria += 1;
          }
          if (nPlaceholder) {
            const s = scoreNeedle(nPlaceholder, attr(el, 'placeholder') || '');
            if (s <= 0) continue;
            total += s;
            criteria += 1;
          }
          if (nText) {
            const s = scoreNeedle(nText, textOf(el, 240));
            if (s <= 0) continue;
            total += s;
            criteria += 1;
          }

          if (criteria === 0) {
            // Role-only (or empty) query: rank by usefulness, not by text.
            if (!wantRole) continue;
            total = 0.5;
            criteria = 1;
          }

          let score = total / criteria;
          if (INTERACTIVE.has(role)) score += 0.02;
          push(scored, { el, role, name, score });
        } catch {
          /* skip unreadable node */
        }
      }

      sortBy(scored, (a, b) => b.score - a.score);

      const limit = typeof q.limit === 'number' && q.limit > 0 ? q.limit : 10;
      const shortlistSize = limit * 4 < 40 ? 40 : limit * 4;
      // `el` is retained so the containment pass below can compare candidates;
      // it is stripped before anything crosses the CDP boundary.
      const shortlist: Array<{ ref: Ref; role: string; name: string; score: number; el: Element }> = [];
      for (let i = 0; i < scored.length && i < shortlistSize; i += 1) {
        const item = scored[i];
        if (!item) continue;
        let score = item.score;
        try {
          if (isVisible(item.el)) score += 0.05;
          const rect = rectOf(item.el);
          if (rect && rect.bottom > 0 && rect.right > 0 && rect.top < vp.h && rect.left < vp.w) score += 0.05;
          if (!matches(item.el, ':disabled') && ariaBool(item.el, 'aria-disabled') !== true) score += 0.03;
        } catch {
          /* boosts are optional */
        }
        if (score > 1) score = 1;
        const name = item.name || accName(item.el, item.role as SnapRole, localNameOf(item.el), 120);
        push(shortlist, { ref: refFor(item.el), role: item.role, name, score, el: item.el });
      }

      sortBy(shortlist, (a, b) => b.score - a.score);

      // Drop containers that merely inherit their name from a descendant we
      // also matched. A <details>/<summary> accordion, a label wrapping its
      // input, a card wrapping its only button — all produce two candidates
      // with the same accessible name and near-identical scores, which the
      // resolver would then report as ambiguous. That is a false positive: the
      // caller wants the innermost thing, and asking them to disambiguate an
      // element from its own toggle costs a round trip and teaches nothing.
      const kept: typeof shortlist = [];
      for (let i = 0; i < shortlist.length; i += 1) {
        const outer = shortlist[i];
        if (!outer) continue;
        let containsBetter = false;
        for (let j = 0; j < shortlist.length; j += 1) {
          const inner = shortlist[j];
          if (!inner || i === j || inner.el === outer.el) continue;
          // Only the ancestor is redundant, and only when the descendant is at
          // least as good a match — a genuinely better-named descendant of a
          // poorly-named container is still two distinct answers.
          if (inner.score + 0.1 >= outer.score && outer.el.contains(inner.el)) {
            containsBetter = true;
            break;
          }
        }
        if (!containsBetter) push(kept, outer);
      }

      for (let i = 0; i < kept.length && i < limit; i += 1) {
        const item = kept[i];
        if (!item) continue;
        const entry: FindCandidate = { ref: item.ref, role: item.role, name: item.name, score: item.score };
        const path = tabPathFor(item.el);
        if (path.length) entry.tabPath = path;
        push(out, entry);
      }
    } catch {
      /* find must never throw into the executor */
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // structure()
  // -------------------------------------------------------------------------

  function groupLabelFor(el: Element): string {
    const group = closestEl(el, '[role="tablist"],nav,[role="navigation"]');
    if (!group) return '';
    const own = attr(group, 'aria-label');
    if (own) return truncate(norm(own), 60);
    const labelledBy = labelledByText(group, 120);
    if (labelledBy) return truncate(labelledBy, 60);
    const prev = group.previousElementSibling;
    if (prev && /^h[1-6]$/.test(localNameOf(prev))) return truncate(textOf(prev, 120), 60);
    return '';
  }

  function structure(): {
    tabs: Array<{ ref: Ref; label: string; selected: boolean; group?: string }>;
    sections: Array<{ ref: Ref; label: string; collapsed: boolean }>;
  } {
    const tabs: Array<{ ref: Ref; label: string; selected: boolean; group?: string }> = [];
    const sections: Array<{ ref: Ref; label: string; collapsed: boolean }> = [];
    try {
      styleCache = new WeakMapCtor<Element, CSSStyleDeclaration | null>();
      styleBudget = 60;

      const seen = new SetCtor<Element>();
      const tabCandidates = qsa(doc, '[role="tab"],[role="tablist"] a,[role="tablist"] button', 200);

      // Nav bars act as tabs when exactly one item is marked current.
      const navs = qsa(doc, 'nav,[role="navigation"]', 20);
      for (let i = 0; i < navs.length; i += 1) {
        const nav = navs[i];
        if (!nav) continue;
        const links = qsa(nav, 'a[href]', 40);
        if (links.length === 0 || links.length > 20) continue;
        let hasCurrent = false;
        for (let k = 0; k < links.length; k += 1) {
          const link = links[k];
          if (link && attr(link, 'aria-current') !== null) hasCurrent = true;
        }
        if (!hasCurrent) continue;
        for (let k = 0; k < links.length; k += 1) {
          const link = links[k];
          if (link) push(tabCandidates, link);
        }
      }

      for (let i = 0; i < tabCandidates.length; i += 1) {
        const el = tabCandidates[i];
        if (!el || seen.has(el)) continue;
        seen.add(el);
        if (!isVisible(el)) continue;
        const label = accName(el, 'tab', localNameOf(el), 60);
        if (!label) continue;
        const entry: { ref: Ref; label: string; selected: boolean; group?: string } = {
          ref: refFor(el),
          label,
          selected: looksActive(el),
        };
        const group = groupLabelFor(el);
        if (group) entry.group = group;
        push(tabs, entry);
      }

      const sectionCandidates = qsa(doc, 'details,[aria-expanded],[data-state="open"],[data-state="closed"]', 300);
      const seenSections = new SetCtor<Element>();
      for (let i = 0; i < sectionCandidates.length; i += 1) {
        const el = sectionCandidates[i];
        if (!el || seenSections.has(el)) continue;
        seenSections.add(el);
        if (!isVisible(el)) continue;
        const tag = localNameOf(el);
        let collapsed: boolean;
        if (tag === 'details') collapsed = !(el as HTMLDetailsElement).open;
        else {
          const expanded = ariaBool(el, 'aria-expanded');
          if (expanded === undefined) {
            const dataState = lower(attr(el, 'data-state') || '');
            if (dataState !== 'open' && dataState !== 'closed') continue;
            collapsed = dataState === 'closed';
          } else {
            collapsed = !expanded;
          }
        }
        const role = computeRole(el, tag);
        const label = accName(el, role, tag, 60);
        if (!label) continue;
        push(sections, { ref: refFor(el), label, collapsed });
      }
    } catch {
      /* structure is advisory; return what we found */
    }
    return { tabs, sections };
  }

  // -------------------------------------------------------------------------
  // Ref utilities
  // -------------------------------------------------------------------------

  function selectorForRef(ref: Ref): string | null {
    const el = elForRef(ref);
    if (!el || !el.isConnected) return null;
    // Refs are `e<digits>` (validated in elForRef), so no escaping is needed.
    return '[' + REF_ATTR + '="' + ref + '"]';
  }

  function hasRef(ref: Ref): boolean {
    const el = elForRef(ref);
    return !!el && el.isConnected;
  }

  function descriptorFor(el: Element, detailed: boolean): string {
    let out = localNameOf(el) || 'node';
    const id = attr(el, 'id');
    if (id) return out + '#' + norm(id).split(' ')[0];
    if (detailed) {
      const nameAttr = attr(el, 'name');
      if (nameAttr) return out + '[name=' + truncate(norm(nameAttr), 32) + ']';
      const testId = testIdOf(el);
      if (testId) return out + '[testid=' + truncate(testId, 32) + ']';
    }
    const cls = norm(attr(el, 'class') || '').split(' ')[0];
    if (cls && cls.length <= 24) out += '.' + cls;
    return out;
  }

  function pathOf(el: Element): string {
    const parts: string[] = [];
    let cursor: Element | null = el;
    let depth = 0;
    while (cursor && depth < 4) {
      const ln = localNameOf(cursor);
      if (ln === 'html') break;
      push(parts, descriptorFor(cursor, depth === 0));
      if (ln === 'body' || ln === 'form' || ln === 'dialog') break;
      cursor = cursor.parentElement;
      depth += 1;
    }
    let out = '';
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i];
      if (!part) continue;
      out += (out ? ' > ' : '') + part;
    }
    return out;
  }

  function describe(ref: Ref): { role: string; name: string; value?: string; visible: boolean; path: string } | null {
    const el = elForRef(ref);
    if (!el) return null;
    try {
      styleCache = new WeakMapCtor<Element, CSSStyleDeclaration | null>();
      styleBudget = 20;
      const tag = localNameOf(el);
      const role = computeRole(el, tag);
      const result: { role: string; name: string; value?: string; visible: boolean; path: string } = {
        role,
        name: accName(el, role, tag, 120),
        visible: el.isConnected && isVisible(el),
        path: pathOf(el),
      };
      const value = valueOf(el, role, tag);
      if (value) result.value = value;
      return result;
    } catch {
      return null;
    }
  }

  function scrollIntoView(ref: Ref): boolean {
    const el = elForRef(ref);
    if (!el || !el.isConnected) return false;
    try {
      // No smooth behaviour: it burns hundreds of milliseconds of wall clock.
      elScrollIntoView.call(el, { block: 'center', inline: 'center' });
      return true;
    } catch {
      try {
        elScrollIntoView.call(el, false);
        return true;
      } catch {
        return false;
      }
    }
  }

  function drainProblems(): string[] {
    const out: string[] = [];
    for (let i = 0; i < problems.length; i += 1) {
      const item = problems[i];
      if (item) push(out, item);
    }
    problems.length = 0;
    return out;
  }

  function reset(): void {
    refToEl = new MapCtor<string, Element>();
    refCounter = 0;
    problems.length = 0;
    styleCache = new WeakMapCtor<Element, CSSStyleDeclaration | null>();
    // Stale `data-fba` attributes from the previous generation would otherwise
    // collide with freshly minted refs after the counter restarts.
    try {
      const stale = qsa(doc, '[' + REF_ATTR + ']', 20000);
      for (let i = 0; i < stale.length; i += 1) {
        const el = stale[i];
        if (!el) continue;
        try {
          elRemoveAttribute.call(el, REF_ATTR);
        } catch {
          /* read-only node */
        }
      }
    } catch {
      /* nothing to clean */
    }
  }

  // -------------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------------

  const api: PageRuntimeApi = {
    version: VERSION,
    snapshot,
    waitSettled,
    isSettled,
    selectorForRef,
    hasRef,
    describe,
    find,
    structure,
    scrollIntoView,
    drainProblems,
    reset,
  };

  try {
    objAssign(win, { __fba: api });
  } catch {
    win.__fba = api;
  }
}

/**
 * The runtime as a self-executing JS source string, ready for
 * `page.addInitScript()` / `page.evaluate()`.
 *
 * See the header comment before changing how this is produced.
 */
export const PAGE_RUNTIME_SOURCE = `(${installFbaRuntime.toString()})();`;

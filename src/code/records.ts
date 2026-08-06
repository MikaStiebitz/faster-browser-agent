/**
 * Generic record extraction from bracketed literals.
 *
 * The built-in route extractors cover twelve JS frameworks, which is worth
 * nothing to a legacy monolith whose entire navigation lives in one hand-rolled
 * registry array. Those registries are structurally simple — a list of records
 * of `key => value` pairs — regardless of whether they are written in PHP, JS
 * or JSON, so one scanner plus a user-supplied field mapping unlocks all of
 * them without teaching the indexer a new framework.
 *
 * Handles `'key' => 'value'` (PHP), `key: 'value'` (JS) and `"key": "value"`
 * (JSON) uniformly, skipping strings and comments so a `//` inside a URL or a
 * `]` inside a label cannot desynchronise the scan.
 */

export interface ExtractedRecord {
  fields: Record<string, string>;
  /** 1-based line of the record's opening bracket. */
  line: number;
}

export interface ExtractRecordsOptions {
  /** Stop after this many records. */
  maxRecords?: number;
  /** A record must carry at least this many pairs to count. */
  minFields?: number;
}

const DEFAULT_MAX_RECORDS = 2_000;

/**
 * Pull every record-shaped block out of a source file.
 *
 * A "record" is a `[...]` or `{...}` block whose *own* text — excluding nested
 * blocks — contains at least `minFields` key/value pairs. That definition is
 * what makes the outer container disappear naturally: the array wrapping the
 * records has no direct pairs of its own, so only the entries are emitted.
 */
export function extractRecords(content: string, options: ExtractRecordsOptions = {}): ExtractedRecord[] {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const minFields = options.minFields ?? 2;
  const out: ExtractedRecord[] = [];

  // Text of each open block, with nested blocks elided as a single space so a
  // child's pairs are never attributed to its parent.
  const stack: Array<{ start: number; text: string[] }> = [];
  const lineStarts = buildLineStarts(content);

  let i = 0;
  const length = content.length;

  while (i < length && out.length < maxRecords) {
    const ch = content[i]!;

    // --- skip strings ------------------------------------------------------
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(content, i);
      // Only the innermost frame collects text. Pushing to every frame would
      // make a parent inherit its first child's pairs and emit the wrapping
      // array as a bogus record of its own.
      stack[stack.length - 1]?.text.push(content.slice(i, end));
      i = end;
      continue;
    }

    // --- skip comments -----------------------------------------------------
    if (ch === '/' && content[i + 1] === '/') {
      i = skipTo(content, i, '\n');
      continue;
    }
    if (ch === '#') {
      i = skipTo(content, i, '\n');
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end === -1 ? length : end + 2;
      continue;
    }

    // --- block structure ---------------------------------------------------
    if (ch === '[' || ch === '{' || (ch === '(' && isArrayCall(content, i))) {
      stack.push({ start: i, text: [] });
      i += 1;
      continue;
    }
    if (ch === ']' || ch === '}' || ch === ')') {
      const frame = stack.pop();
      if (frame) {
        const fields = parsePairs(frame.text.join(''));
        if (Object.keys(fields).length >= minFields) {
          out.push({ fields, line: lineOf(lineStarts, frame.start) });
        }
        // The closed block becomes opaque filler in its parent.
        stack[stack.length - 1]?.text.push(' ');
      }
      i += 1;
      continue;
    }

    stack[stack.length - 1]?.text.push(ch);
    i += 1;
  }

  return out;
}

/** PHP's legacy `array(...)` syntax opens a record just like `[`. */
function isArrayCall(content: string, index: number): boolean {
  const before = content.slice(Math.max(0, index - 6), index).toLowerCase();
  return /\barray$/.test(before);
}

function skipString(content: string, start: number): number {
  const quote = content[start];
  let i = start + 1;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return content.length;
}

function skipTo(content: string, start: number, marker: string): number {
  const end = content.indexOf(marker, start);
  return end === -1 ? content.length : end + marker.length;
}

/**
 * `'page' => 'orders'`, `page: "orders"`, `"page": "orders"`.
 *
 * Only string-valued pairs are kept: a registry entry's routable fields are
 * always literals, and accepting expressions would fill the index with
 * unresolvable `$foo` values.
 */
const PAIR_RE =
  /(?:'([A-Za-z_][\w.-]*)'|"([A-Za-z_][\w.-]*)"|([A-Za-z_][\w.-]*))\s*(?:=>|:)\s*(?:'((?:[^'\\]|\\.){0,200})'|"((?:[^"\\]|\\.){0,200})")/g;

function parsePairs(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  PAIR_RE.lastIndex = 0;
  for (let m = PAIR_RE.exec(text); m; m = PAIR_RE.exec(text)) {
    const key = m[1] ?? m[2] ?? m[3];
    const value = m[4] ?? m[5];
    if (!key || value === undefined) continue;
    // First writer wins: a nested override should not shadow the record's own.
    if (!(key in fields)) fields[key] = unescape(value);
  }
  return fields;
}

function unescape(value: string): string {
  return value.replace(/\\(['"\\/])/g, '$1').replace(/\\n/g, ' ').trim();
}

function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Render `index.php?page={page}&sub={sub}` from a record.
 *
 * Query segments whose placeholders resolve empty are dropped rather than
 * emitted as `&sub=`, because a trailing empty parameter changes which page a
 * real application serves. Returns undefined when the path itself is
 * unresolvable — a URL with a literal `{page}` in it is a broken link.
 */
export function renderTemplate(template: string, fields: Record<string, string>): string | undefined {
  const [pathPart = '', queryPart] = splitOnce(template, '?');

  const path = fill(pathPart, fields);
  if (path === undefined) return undefined;

  if (!queryPart) return path;
  const segments = queryPart
    .split('&')
    .map((segment) => fill(segment, fields))
    .filter((segment): segment is string => segment !== undefined && segment !== '');

  return segments.length === 0 ? path : `${path}?${segments.join('&')}`;
}

function fill(template: string, fields: Record<string, string>): string | undefined {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_all, name: string) => {
    const value = fields[name];
    if (value === undefined || value === '') {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? undefined : out;
}

function splitOnce(input: string, separator: string): [string, string?] {
  const index = input.indexOf(separator);
  if (index === -1) return [input];
  return [input.slice(0, index), input.slice(index + separator.length)];
}

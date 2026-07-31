/**
 * Configuration-schema extraction (L3).
 *
 * A settings screen is almost always a rendering of a schema that already
 * exists in the codebase. Indexing that schema tells the agent which fields
 * exist, what they are called, which are required and what the legal values
 * are — before it has looked at a single pixel. That turns "explore the
 * settings UI to find out what can be configured" into a lookup.
 *
 * Sources, in order of reliability: zod / yup / joi schemas, JSON Schema
 * documents, TypeScript `*Config`/`*Settings` types, and shipped default
 * config objects.
 */

import { basename } from 'node:path';

import type { ConfigFieldEntry } from '../types.js';
import { normalizeText } from '../util/text.js';
import {
  makeLineIndex,
  readSources,
  sliceBalanced,
  splitTopLevel,
  stripComments,
  type ScannedFile,
  type SourceFile,
} from './scan.js';

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_FIELDS = 2000;
const MAX_DEPTH = 6;

/** `z.object(`, `yup.object(`, `Joi.object(` — the schema builders we read. */
const SCHEMA_OBJECT_RE = /\b(z|zod|yup|y|Joi|joi)\s*\.\s*object\s*\(/g;

/** Interfaces and type aliases that are, by name, configuration shapes. */
const CONFIG_TYPE_RE =
  /\b(?:export\s+)?(?:declare\s+)?(?:interface\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)\s*=)/g;
const CONFIG_NAME_RE = /Config|Settings|Options|Preferences|Prefs/;

const MEMBER_RE = /^(?:readonly\s+)?(['"]?)([A-Za-z_$][\w$-]*)\1(\?)?\s*:\s*([\s\S]+)$/;

export async function extractConfigFields(root: string, files: ScannedFile[]): Promise<ConfigFieldEntry[]> {
  // See `extractRoutes`: `root` is signature symmetry, paths come from `files`.
  void root;
  const out: ConfigFieldEntry[] = [];
  const seen = new Set<string>();

  const add = (entry: ConfigFieldEntry): void => {
    if (out.length >= MAX_FIELDS) return;
    if (!entry.path || entry.path.length > 120) return;
    const key = entry.path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  const code = files.filter((f) => CODE_EXTS.has(f.ext));
  const json = files.filter((f) => f.ext === '.json' && isConfigJson(f.rel));
  const sources = await readSources([...code, ...json], { concurrency: 16 });

  for (const source of sources) {
    if (source.ext === '.json') extractJson(source, add);
    else {
      const content = stripComments(source.content);
      extractSchemaBuilders(source, content, add);
      extractConfigTypes(source, content, add);
    }
    if (out.length >= MAX_FIELDS) break;
  }

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// zod / yup / joi
// ---------------------------------------------------------------------------

function extractSchemaBuilders(
  source: SourceFile,
  content: string,
  add: (entry: ConfigFieldEntry) => void,
): void {
  if (!/\.\s*object\s*\(/.test(content)) return;
  const lineOf = makeLineIndex(content);
  // Nested `object()` calls are walked from their parent; skipping ranges we
  // already covered keeps every field at exactly one dotted path.
  let processedUntil = -1;

  SCHEMA_OBJECT_RE.lastIndex = 0;
  for (let m = SCHEMA_OBJECT_RE.exec(content); m; m = SCHEMA_OBJECT_RE.exec(content)) {
    if (m.index < processedUntil) continue;
    const ns = m[1];
    if (!ns) continue;
    const parenIndex = m.index + m[0].length - 1;
    const call = sliceBalanced(content, parenIndex);
    if (!call) continue;
    const braceIndex = content.indexOf('{', parenIndex);
    if (braceIndex < 0 || braceIndex > call.end) continue;
    const shape = sliceBalanced(content, braceIndex);
    if (!shape) continue;
    processedUntil = call.end;
    // yup/joi treat fields as optional unless `.required()` says otherwise;
    // zod is the other way round.
    const requiredByDefault = ns === 'z' || ns === 'zod';
    walkSchemaShape(shape.body, '', source.rel, lineOf(braceIndex), requiredByDefault, 0, add);
  }
}

function walkSchemaShape(
  body: string,
  prefix: string,
  rel: string,
  line: number,
  requiredByDefault: boolean,
  depth: number,
  add: (entry: ConfigFieldEntry) => void,
): void {
  if (depth > MAX_DEPTH) return;
  for (const member of splitTopLevel(body, ',')) {
    const colon = indexOfTopLevelColon(member);
    if (colon < 0) continue;
    const key = member.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    if (!/^[A-Za-z_$][\w$-]*$/.test(key)) continue;
    const expr = member.slice(colon + 1).trim();
    const path = prefix ? `${prefix}.${key}` : key;

    const nested = findNestedObject(expr);
    if (nested) {
      walkSchemaShape(nested, path, rel, line, requiredByDefault, depth + 1, add);
      continue;
    }

    const optional = /\.\s*(?:optional|nullish|nullable|default)\s*\(/.test(expr);
    const explicitlyRequired = /\.\s*required\s*\(/.test(expr);
    const enumValues = schemaEnumValues(expr);
    add({
      path,
      type: schemaType(expr, enumValues),
      label: schemaLabel(expr),
      enumValues,
      required: requiredByDefault ? !optional : explicitlyRequired,
      source: `${rel}:${line}`,
    });
  }
}

/** Body of a nested `*.object({ ... })` inside a member expression. */
function findNestedObject(expr: string): string | undefined {
  const m = /\b(?:z|zod|yup|y|Joi|joi)\s*\.\s*object\s*\(/.exec(expr);
  if (!m) return undefined;
  const braceIndex = expr.indexOf('{', m.index + m[0].length - 1);
  if (braceIndex < 0) return undefined;
  const shape = sliceBalanced(expr, braceIndex);
  return shape?.body;
}

function schemaType(expr: string, enumValues: string[] | undefined): string | undefined {
  if (enumValues && enumValues.length > 0) return 'enum';
  const m = /\b(?:z|zod|yup|y|Joi|joi)\s*\.\s*(?:coerce\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
  const type = m?.[1];
  if (!type) return undefined;
  if (type === 'array') {
    const inner = /\.\s*array\s*\(\s*(?:z|zod|yup|y|Joi|joi)\s*\.\s*([A-Za-z_$][\w$]*)/.exec(expr)?.[1];
    return inner ? `${inner}[]` : 'array';
  }
  return type;
}

function schemaLabel(expr: string): string | undefined {
  const m = /\.\s*(?:describe|label|meta)\s*\(\s*['"]([^'"]{1,120})['"]/.exec(expr);
  return m?.[1] ? normalizeText(m[1]) : undefined;
}

function schemaEnumValues(expr: string): string[] | undefined {
  const enumCall = /\.\s*(?:enum|oneOf|valid)\s*\(/.exec(expr);
  if (enumCall) {
    const open = enumCall.index + enumCall[0].length - 1;
    const call = sliceBalanced(expr, open);
    if (call) {
      const values = stringLiterals(call.body);
      if (values.length > 0) return values;
    }
  }
  // `z.union([z.literal('a'), z.literal('b')])`
  if (/\.\s*union\s*\(/.test(expr)) {
    const values: string[] = [];
    const re = /\.\s*literal\s*\(\s*['"]([^'"]{1,80})['"]/g;
    for (let m = re.exec(expr); m; m = re.exec(expr)) {
      if (m[1]) values.push(m[1]);
    }
    if (values.length > 0) return values;
  }
  return undefined;
}

function stringLiterals(body: string): string[] {
  const out: string[] = [];
  const re = /['"]([^'"\n]{1,80})['"]/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function indexOfTopLevelColon(member: string): number {
  let depth = 0;
  for (let i = 0; i < member.length; i++) {
    const ch = member[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) return i;
    else if ((ch === '"' || ch === "'") && depth === 0) {
      // Skip a quoted key so a colon inside it is not mistaken for the split.
      const quote = ch;
      i++;
      while (i < member.length && member[i] !== quote) i += member[i] === '\\' ? 2 : 1;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// TypeScript config types
// ---------------------------------------------------------------------------

function extractConfigTypes(source: SourceFile, content: string, add: (entry: ConfigFieldEntry) => void): void {
  if (!CONFIG_NAME_RE.test(content)) return;
  const lineOf = makeLineIndex(content);

  CONFIG_TYPE_RE.lastIndex = 0;
  for (let m = CONFIG_TYPE_RE.exec(content); m; m = CONFIG_TYPE_RE.exec(content)) {
    const name = m[1] ?? m[2];
    if (!name || !CONFIG_NAME_RE.test(name)) continue;
    const braceIndex = content.indexOf('{', m.index + m[0].length);
    if (braceIndex < 0) continue;
    // The body must follow closely; anything else is a different declaration.
    const between = content.slice(m.index + m[0].length, braceIndex);
    if (between.length > 200 || between.includes(';') || between.includes('}')) continue;
    const body = sliceBalanced(content, braceIndex);
    if (!body) continue;
    walkTypeBody(body.body, '', source.rel, lineOf(braceIndex), 0, add);
    CONFIG_TYPE_RE.lastIndex = body.end;
  }
}

function walkTypeBody(
  body: string,
  prefix: string,
  rel: string,
  line: number,
  depth: number,
  add: (entry: ConfigFieldEntry) => void,
): void {
  if (depth > MAX_DEPTH) return;
  for (const member of typeMembers(body)) {
    // `[key: string]: T` is an index signature, not a field.
    if (member.startsWith('[')) continue;
    const m = MEMBER_RE.exec(member);
    if (!m) continue;
    const key = m[2];
    if (!key) continue;
    const optional = m[3] === '?';
    const type = (m[4] ?? '').trim().replace(/[;,]$/, '');
    const path = prefix ? `${prefix}.${key}` : key;

    if (type.startsWith('{')) {
      const nested = sliceBalanced(type, 0);
      if (nested) {
        walkTypeBody(nested.body, path, rel, line, depth + 1, add);
        continue;
      }
    }

    const enumValues = unionLiterals(type);
    add({
      path,
      type: enumValues ? 'enum' : normalizeText(type) || undefined,
      enumValues,
      required: !optional,
      source: `${rel}:${line}`,
    });
  }
}

/** Split an interface body into members on `;`, `,` and newlines. */
function typeMembers(body: string): string[] {
  const out: string[] = [];
  for (const chunk of splitTopLevel(body, ';')) {
    for (const line of splitTopLevel(chunk, '\n')) {
      for (const part of splitTopLevel(line, ',')) {
        const trimmed = part.trim();
        if (trimmed) out.push(trimmed);
      }
    }
  }
  return out;
}

function unionLiterals(type: string): string[] | undefined {
  if (!type.includes('|')) return undefined;
  const parts = type.split('|').map((p) => p.trim());
  const values: string[] = [];
  for (const part of parts) {
    const m = /^['"]([^'"]{1,80})['"]$/.exec(part);
    if (!m || !m[1]) return undefined;
    values.push(m[1]);
  }
  return values.length > 0 ? values : undefined;
}

// ---------------------------------------------------------------------------
// JSON: schemas and shipped defaults
// ---------------------------------------------------------------------------

function isConfigJson(rel: string): boolean {
  const base = basename(rel).toLowerCase();
  if (/\.(schema|config|settings)\.json$/.test(base)) return true;
  return ['config.json', 'settings.json', 'schema.json', 'appsettings.json', 'defaults.json'].includes(base);
}

function extractJson(source: SourceFile, add: (entry: ConfigFieldEntry) => void): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.content);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const root = parsed as Record<string, unknown>;

  if (root['properties'] && typeof root['properties'] === 'object') {
    walkJsonSchema(root, '', source.rel, 0, add);
    return;
  }
  walkDefaults(root, '', source.rel, 0, add);
}

function walkJsonSchema(
  node: Record<string, unknown>,
  prefix: string,
  rel: string,
  depth: number,
  add: (entry: ConfigFieldEntry) => void,
): void {
  if (depth > MAX_DEPTH) return;
  const properties = node['properties'];
  if (!properties || typeof properties !== 'object') return;
  const requiredList = Array.isArray(node['required'])
    ? (node['required'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  for (const [key, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const schema = raw as Record<string, unknown>;
    const path = prefix ? `${prefix}.${key}` : key;
    if (schema['properties'] && typeof schema['properties'] === 'object') {
      walkJsonSchema(schema, path, rel, depth + 1, add);
      continue;
    }
    const enumRaw = schema['enum'];
    const enumValues = Array.isArray(enumRaw)
      ? enumRaw.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map(String)
      : undefined;
    const title = schema['title'] ?? schema['description'];
    add({
      path,
      type: typeof schema['type'] === 'string' ? (schema['type'] as string) : enumValues ? 'enum' : undefined,
      label: typeof title === 'string' ? normalizeText(title) : undefined,
      enumValues: enumValues && enumValues.length > 0 ? enumValues : undefined,
      required: requiredList.includes(key),
      source: rel,
    });
  }
}

function walkDefaults(
  node: Record<string, unknown>,
  prefix: string,
  rel: string,
  depth: number,
  add: (entry: ConfigFieldEntry) => void,
): void {
  if (depth > MAX_DEPTH) return;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      walkDefaults(value as Record<string, unknown>, path, rel, depth + 1, add);
      continue;
    }
    add({
      path,
      type: Array.isArray(value) ? 'array' : value === null ? undefined : typeof value,
      source: rel,
      // A shipped default says nothing about whether the field is mandatory.
      required: undefined,
    });
  }
}

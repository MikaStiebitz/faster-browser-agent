/**
 * L1 page runtime — public entry point.
 *
 * The session layer injects `PAGE_RUNTIME_SOURCE` into every document and uses
 * `RUNTIME_VERSION` to decide whether an already-installed `window.__fba` is
 * current.
 */

export { PAGE_RUNTIME_SOURCE, RUNTIME_VERSION } from './page-runtime.js';

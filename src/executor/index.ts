/**
 * L2 — the executor.
 *
 * `resolve` finds elements and heals stale references, `act` runs guarded
 * action programs without further model involvement, and `form` fills whole
 * forms in a single deterministic pass.
 */

export {
  DefaultTargetResolver,
  describeTarget,
  hasSelector,
  selectorForRef,
  targetResolver,
  type TargetResolverOptions,
} from './resolve.js';

export { DefaultExecutor, executor, type ExecutorOptions } from './act.js';

export {
  actionForRole,
  coerceBoolean,
  collectCandidates,
  fillForm,
  pickSubmitTarget,
  type FieldAction,
  type FieldCandidate,
  type FieldValue,
  type SubmitCandidate,
} from './form.js';

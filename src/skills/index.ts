/**
 * L3 skill cache — public entry point.
 *
 * `FsSkillStore` persists compiled trajectories; `DefaultSkillRunner` replays
 * them with zero model calls and fails loudly when the app has drifted.
 * `compileFromSteps` turns a program that just succeeded into a stored skill.
 */

export {
  FsSkillStore,
  extractParams,
  interpolateSteps,
  normalizeOrigin,
  normalizeSkillName,
  originSlug,
  skillKey,
  validateSkill,
} from './store.js';

export { DefaultSkillRunner, compileFromSteps } from './runner.js';
export type { CompileOptions } from './runner.js';

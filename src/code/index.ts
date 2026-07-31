/**
 * The code index (L3) — public surface.
 *
 * Reading the application's source before touching the browser is what lets
 * the agent deep-link instead of clicking, and resolve "the SMTP port field"
 * to a selector without a snapshot.
 */

export {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_FILE_BYTES,
  EXCLUDED_DIRS,
  SOURCE_EXTENSIONS,
  clearSourceCache,
  forEachCodeChar,
  groupByArray,
  isSourceFile,
  makeLineIndex,
  mapPool,
  readSources,
  scanObjectLiterals,
  scanWorkspace,
  sliceBalanced,
  splitTopLevel,
  stripComments,
  type ObjectLiteral,
  type ReadSourcesOptions,
  type ScanOptions,
  type ScannedFile,
  type SourceFile,
} from './scan.js';

export {
  detectBaseUrl,
  detectFrameworks,
  extractRoutes,
  hasUnresolvedParams,
  normalizePattern,
  patternParams,
  routeToPath,
  titleCase,
} from './routes.js';

export { extractNavGroups, extractSelectors } from './selectors.js';

export { extractConfigFields } from './config-fields.js';

export { absoluteUrl, isConcretePath, searchIndex, selectorTarget } from './match.js';

export { FsCodeIndexer, buildIndex, emptyIndex } from './indexer.js';

// @ts-check

const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * Convert the canonical parent-before-child review stack into generation units.
 *
 * @param {ReadonlyArray<import('../core/types.ts').ReviewCommitSummary>} commits
 * @returns {ReadonlyArray<import('../core/types.ts').ReviewCommitUnit>}
 */
const createCommitWalkthroughUnits = (commits) =>
  commits.map((commit, order) => ({ commit, kind: 'commit', order, reviewable: true }));

/** @type {Promise<typeof import('../core/walkthrough-authoring.ts')> | null} */
let modulePromise = null;

const loadGenerate = () => {
  if (!modulePromise) {
    const modulePath = join(__dirname, '../core/dist/walkthrough-authoring.mjs');
    modulePromise = import(pathToFileURL(modulePath).href);
  }
  return modulePromise;
};

/**
 * @param {Parameters<typeof import('../core/lib/generate-review-walkthrough.ts').generateReviewWalkthrough>[0]} input
 */
const generateReviewWalkthrough = async (input) => {
  const module = await loadGenerate();
  return module.generateReviewWalkthrough(input);
};

/** @param {unknown} value */
const parsePersistedWalkthrough = async (value) => {
  const indexPath = join(__dirname, '../core/dist/index.mjs');
  const index = await import(pathToFileURL(indexPath).href);
  return value && typeof value === 'object' && 'version' in value && value.version === 5
    ? index.parseWalkthroughArtifactV5(value)
    : index.parseNarrativeWalkthroughV4(value);
};

module.exports = {
  createCommitWalkthroughUnits,
  generateReviewWalkthrough,
  parsePersistedWalkthrough,
};

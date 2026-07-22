// @ts-check

/**
 * CJS bridge to Core generateReviewWalkthrough (ESM).
 */

const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

/** @type {Promise<typeof import('../core/dist/walkthrough-authoring.mjs')> | null} */
let modulePromise = null;

const loadGenerate = async () => {
  if (!modulePromise) {
    // generateReviewWalkthrough is exported from walkthrough-authoring barrel after build.
    const modulePath = join(__dirname, '../core/dist/walkthrough-authoring.mjs');
    modulePromise = import(pathToFileURL(modulePath).href);
  }
  return modulePromise;
};

/**
 * @param {Parameters<typeof import('../core/lib/generate-review-walkthrough.ts').generateReviewWalkthrough>[0]} input
 */
const generateReviewWalkthrough = async (input) => {
  const mod = await loadGenerate();
  if (typeof mod.generateReviewWalkthrough !== 'function') {
    // Fallback: dynamic import of core dist index if barrel not yet rebuilt.
    const indexPath = join(__dirname, '../core/dist/index.mjs');
    const index = await import(pathToFileURL(indexPath).href);
    return index.generateReviewWalkthrough(input);
  }
  return mod.generateReviewWalkthrough(input);
};

module.exports = {
  generateReviewWalkthrough,
  loadGenerate,
};

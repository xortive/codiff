// @ts-check

/**
 * Provider-neutral local review-history facade.
 * Dispatches to GitLab (native versions) or GitHub (force-push heads).
 */

const {
  compareGitLabReviewVersions,
  listGitLabReviewVersions,
  loadGitLabVersionCommitUnitDiff,
} = require('./gitlab-review-history.cjs');
const {
  compareGitHubReviewVersions,
  listGitHubReviewVersions,
  loadGitHubVersionCommitUnitDiff,
} = require('./github-history/github-review-history.cjs');

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').ReviewEvolutionUnit} ReviewEvolutionUnit
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../core/types.ts').ReviewVersionOption} ReviewVersionOption
 * @typedef {Extract<ReviewSource, { type: 'pull-request' }>} PullRequestSource
 */

/**
 * @param {PullRequestSource} source
 */
const isGitLabSource = (source) => source.provider === 'gitlab';

/**
 * @param {PullRequestSource} source
 */
const isGitHubSource = (source) =>
  source.provider === 'github' ||
  (!source.provider && !source.host) ||
  source.host === 'github.com';

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @returns {Promise<{ versions: ReadonlyArray<ReviewVersionOption>, warning?: string | null }>}
 */
const listReviewVersions = async (repoRoot, source) => {
  if (isGitLabSource(source)) {
    const versions = await listGitLabReviewVersions(repoRoot, source);
    return { versions, warning: null };
  }
  if (isGitHubSource(source)) {
    return listGitHubReviewVersions(repoRoot, source);
  }
  return {
    versions: [],
    warning: 'Review history is not available for this pull request provider.',
  };
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{ fromId: string, toId: string }} range
 * @param {ReadonlyArray<ReviewVersionOption>} [versions]
 */
const compareReviewVersions = async (repoRoot, source, range, versions) => {
  if (isGitLabSource(source)) {
    const result = await compareGitLabReviewVersions(repoRoot, source, range);
    return { ...result, warning: null };
  }
  if (isGitHubSource(source)) {
    const resolvedVersions =
      versions ?? (await listGitHubReviewVersions(repoRoot, source)).versions;
    return compareGitHubReviewVersions(repoRoot, source, range, resolvedVersions);
  }
  throw new Error('Review version compare is not available for this pull request provider.');
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {ReviewEvolutionUnit} unit
 * @returns {Promise<ReadonlyArray<ChangedFile>>}
 */
const loadReviewVersionUnitDiff = async (repoRoot, source, unit) => {
  if (isGitLabSource(source)) {
    return loadGitLabVersionCommitUnitDiff(repoRoot, source, unit);
  }
  if (isGitHubSource(source)) {
    return loadGitHubVersionCommitUnitDiff(repoRoot, unit);
  }
  throw new Error('Review version unit diffs are not available for this pull request provider.');
};

module.exports = {
  compareReviewVersions,
  isGitHubSource,
  isGitLabSource,
  listReviewVersions,
  loadReviewVersionUnitDiff,
};

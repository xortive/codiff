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
 * @param {{
 *   from?: import('../../core/types.ts').ReviewVersionCompareEndpoint,
 *   fromId?: string,
 *   to?: import('../../core/types.ts').ReviewVersionCompareEndpoint,
 *   toId?: string,
 * }} range
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
    const endpointId = (
      /** @type {import('../../core/types.ts').ReviewVersionCompareEndpoint | undefined} */ endpoint,
      /** @type {string | undefined} */ fallbackId,
    ) => {
      if (!endpoint) return fallbackId;
      if (endpoint.kind === 'version') return endpoint.id;
      if (endpoint.kind === 'head-sha') return endpoint.sha;
      if (endpoint.kind === 'comment-position') return endpoint.headSha;
      return resolvedVersions[0]?.id;
    };
    const fromId = endpointId(range.from, range.fromId);
    const toId = endpointId(range.to, range.toId);
    if (!fromId || !toId) {
      throw new Error('GitHub review comparison endpoints could not be resolved.');
    }
    return compareGitHubReviewVersions(repoRoot, source, { fromId, toId }, resolvedVersions);
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

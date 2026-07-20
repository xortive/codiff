// @ts-check

/**
 * Local GitLab review-history adapter over glab transport + @nkzw/codiff-gitlab.
 */

const { createGlabGitLabTransport } = require('./glab-gitlab-transport.cjs');
const { loadGitLabHistory } = require('../gitlab-history-bridge.cjs');

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').DiffComparisonView} DiffComparisonView
 * @typedef {import('../../core/types.ts').ReviewCommitEvolution} ReviewCommitEvolution
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../core/types.ts').ReviewVersionOption} ReviewVersionOption
 * @typedef {Extract<ReviewSource, { type: 'pull-request' }>} PullRequestSource
 */

const MR_BASE_VERSION_ID = 'mr-base';

/**
 * @param {PullRequestSource} source
 */
const assertGitLabSource = (source) => {
  if (source.provider !== 'gitlab') {
    throw new Error('GitLab review history requires a GitLab merge request source.');
  }
  if (!source.host?.trim()) {
    throw new Error('GitLab review history requires a host on the merge request source.');
  }
  if (!source.projectPath?.trim()) {
    throw new Error('GitLab review history requires a projectPath on the merge request source.');
  }
  if (!source.number || !Number.isInteger(source.number) || source.number <= 0) {
    throw new Error('GitLab review history requires a merge request number.');
  }
  return {
    host: source.host,
    iid: source.number,
    projectPath: source.projectPath,
  };
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 */
const createTransportForSource = (repoRoot, source) => {
  const { host } = assertGitLabSource(source);
  return createGlabGitLabTransport({ hostname: host, repoRoot });
};

/**
 * @param {import('../../gitlab/src/version-compare.ts').MergeRequestVersionRef} version
 * @param {{
 *   diffStat?: ReviewVersionOption['diffStat'],
 *   isHead?: boolean,
 *   number?: number,
 *   previousCreatedAt?: string,
 *   previousNumber?: number,
 * }} [extra]
 * @param {typeof import('../../gitlab/dist/index.mjs')} gitlab
 */
const toReviewVersionOption = (version, extra, gitlab) =>
  gitlab.projectMergeRequestVersionRef({
    ...version,
    ...(extra?.diffStat ? { diffStat: extra.diffStat } : {}),
    ...(extra?.isHead != null ? { isHead: extra.isHead } : {}),
    ...(extra?.number != null ? { number: extra.number } : {}),
    ...(extra?.previousCreatedAt ? { previousCreatedAt: extra.previousCreatedAt } : {}),
    ...(extra?.previousNumber != null ? { previousNumber: extra.previousNumber } : {}),
  });

/**
 * Build Core version options including a synthetic MR-base endpoint so the UI
 * can compare base → v1 the same way Web does.
 *
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @returns {Promise<ReadonlyArray<ReviewVersionOption>>}
 */
const listGitLabReviewVersions = async (repoRoot, source) => {
  const { iid, projectPath } = assertGitLabSource(source);
  const transport = createTransportForSource(repoRoot, source);
  const gitlab = await loadGitLabHistory();
  const versions = await gitlab.fetchGitLabMergeRequestVersions({
    iid,
    projectPath,
    transport,
  });
  if (versions.length === 0) {
    return [];
  }

  // Oldest → newest for picker defaults (from=previous, to=head).
  const chronological = [...versions].toReversed();
  const first = chronological[0];
  const baseOption = toReviewVersionOption(
    {
      baseSha: first.baseSha,
      createdAt: first.createdAt,
      headSha: first.baseSha,
      id: MR_BASE_VERSION_ID,
      label: 'MR base',
      startSha: first.baseSha,
    },
    {
      isHead: false,
      number: 0,
    },
    gitlab,
  );

  const options = chronological.map((version, index) =>
    toReviewVersionOption(
      version,
      {
        isHead: index === chronological.length - 1,
        number: index + 1,
        ...(index > 0
          ? {
              previousCreatedAt: chronological[index - 1].createdAt,
              previousNumber: index,
            }
          : {}),
      },
      gitlab,
    ),
  );

  return [baseOption, ...options];
};

/**
 * @param {string} versionId
 * @param {ReadonlyArray<import('../../gitlab/src/version-compare.ts').MergeRequestVersionRef>} versions
 * @returns {import('../../gitlab/src/version-compare.ts').VersionCompareEndpoint}
 */
const toCompareEndpoint = (versionId, versions) => {
  if (versionId === MR_BASE_VERSION_ID) {
    return { kind: 'mr-base' };
  }
  if (versions.some((version) => version.id === versionId)) {
    return { kind: 'mr-version', versionId };
  }
  // Fall back to head-sha if the UI passed a synthetic head id.
  if (/^[0-9a-f]{7,40}$/i.test(versionId)) {
    return { headSha: versionId, kind: 'head-sha' };
  }
  return { kind: 'mr-version', versionId };
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{ fromId: string, toId: string }} range
 * @returns {Promise<{
 *   versionCompare: DiffComparisonView,
 *   versionCommitEvolution: ReviewCommitEvolution | null,
 *   versionCommitEvolutionError: string | null,
 * }>}
 */
const compareGitLabReviewVersions = async (repoRoot, source, range) => {
  const { iid, projectPath } = assertGitLabSource(source);
  const transport = createTransportForSource(repoRoot, source);
  const gitlab = await loadGitLabHistory();
  const versions = await gitlab.fetchGitLabMergeRequestVersions({
    iid,
    projectPath,
    transport,
  });
  if (versions.length === 0) {
    throw new Error('GitLab did not return merge request versions.');
  }

  const fromEndpoint = toCompareEndpoint(range.fromId, versions);
  const toEndpoint = toCompareEndpoint(range.toId, versions);

  const [compareResult, evolutionResult] = await Promise.allSettled([
    gitlab.fetchGitLabMergeRequestVersionCompare({
      from: fromEndpoint,
      iid,
      projectPath,
      to: toEndpoint,
      transport,
    }),
    gitlab.fetchGitLabMergeRequestVersionCommitEvolution({
      from: fromEndpoint,
      iid,
      projectPath,
      to: toEndpoint,
      transport,
    }),
  ]);

  if (compareResult.status !== 'fulfilled') {
    throw compareResult.reason instanceof Error
      ? compareResult.reason
      : new Error(String(compareResult.reason));
  }

  const versionCompare = gitlab.projectVersionCompare(compareResult.value);
  if (evolutionResult.status === 'fulfilled') {
    return {
      versionCommitEvolution: gitlab.projectCommitEvolution(evolutionResult.value),
      versionCommitEvolutionError: null,
      versionCompare,
    };
  }

  return {
    versionCommitEvolution: null,
    versionCommitEvolutionError:
      evolutionResult.reason instanceof Error
        ? evolutionResult.reason.message
        : String(evolutionResult.reason),
    versionCompare,
  };
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {import('../../gitlab/src/version-commit-evolution.ts').VersionCommitEvolutionUnit | import('../../core/types.ts').ReviewEvolutionUnit} unit
 * @returns {Promise<ReadonlyArray<ChangedFile>>}
 */
const loadGitLabVersionCommitUnitDiff = async (repoRoot, source, unit) => {
  const { projectPath } = assertGitLabSource(source);
  const transport = createTransportForSource(repoRoot, source);
  const gitlab = await loadGitLabHistory();
  // Core projected units use kind names like 'introduced'/'removed'; package
  // algorithm units use 'added'/'removed'/'likely-revised'. Prefer the raw unit
  // shape when the host still holds algorithm units; otherwise reconstruct.
  /** @type {any} */
  const algorithmUnit = unit;
  if (
    algorithmUnit.kind === 'added' ||
    algorithmUnit.kind === 'removed' ||
    algorithmUnit.kind === 'likely-revised' ||
    algorithmUnit.kind === 'unchanged' ||
    algorithmUnit.kind === 'same-patch' ||
    algorithmUnit.kind === 'absorbed-into-base' ||
    algorithmUnit.kind === 'unmatched-old' ||
    algorithmUnit.kind === 'unmatched-new'
  ) {
    return gitlab.fetchGitLabVersionCommitUnitDiff({
      projectPath,
      transport,
      unit: algorithmUnit,
    });
  }

  // Projected Core unit → best-effort mapping for reviewable units.
  if (!algorithmUnit.reviewable) {
    throw new Error('This commit evolution unit is not reviewable.');
  }
  const mapped = {
    confidence: algorithmUnit.confidence === 'exact' ? 'exact' : 'high',
    id: algorithmUnit.id,
    kind:
      algorithmUnit.kind === 'introduced'
        ? 'added'
        : algorithmUnit.kind === 'removed'
          ? 'removed'
          : algorithmUnit.kind === 'revised'
            ? 'likely-revised'
            : algorithmUnit.kind === 'rewritten-same-patch'
              ? 'same-patch'
              : algorithmUnit.kind === 'retained'
                ? 'unchanged'
                : algorithmUnit.kind === 'absorbed-into-base'
                  ? 'absorbed-into-base'
                  : 'unmatched-new',
    reviewable: true,
    ...(algorithmUnit.after ? { after: algorithmUnit.after } : {}),
    ...(algorithmUnit.before ? { before: algorithmUnit.before } : {}),
    ...(algorithmUnit.baseCommit ? { baseCommit: algorithmUnit.baseCommit } : {}),
  };
  return gitlab.fetchGitLabVersionCommitUnitDiff({
    projectPath,
    transport,
    unit: mapped,
  });
};

module.exports = {
  MR_BASE_VERSION_ID,
  compareGitLabReviewVersions,
  listGitLabReviewVersions,
  loadGitLabVersionCommitUnitDiff,
};

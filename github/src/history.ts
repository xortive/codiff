import {
  commitRevisionLabel,
  createCommitPatchSignature,
  diffComparison,
  diffComparisonView,
  diffRange,
  matchVersionCommitStacks,
  projectCommitEvolution,
  reviewVersionOption,
  revisionRef,
  versionCommitDiffConcurrency,
  versionCommitStackLimit,
  versionRevisionLabel,
  type CommitPatchSignature,
  type DiffEndpointRef,
} from '@nkzw/codiff-core';
/**
 * Read-side GitHub review-history adapter over {@link GitHubTransport}.
 *
 * GitHub has no MR version list. Local parity uses force-push head snapshots as
 * the revision timeline. Compare/evolution materialization is host-supplied
 * (local git) so this package stays free of process spawning.
 */
import type {
  ChangedFile,
  DiffComparisonBaseMovement,
  DiffComparisonView,
  ReviewCommitEvolution,
  ReviewEvolutionUnit,
  ReviewVersionOption,
} from '@nkzw/codiff-core/types';
import type { GitHubTransport } from './transport.ts';

export type { GitHubTransport } from './transport.ts';

export type ForcePushEvent = {
  actorLogin?: string;
  after: string;
  before: string;
  createdAt: string;
};

export type GitHubPullRequestRef = {
  /** Optional known head from the local source; PR metadata overrides when available. */
  headSha?: string | null;
  number: number;
  owner: string;
  repo: string;
};

export type GitHubCommitLike = {
  authoredAt: string;
  authorName: string;
  message?: string;
  parentIds: ReadonlyArray<string>;
  sha: string;
  shortSha: string;
  subject: string;
  title?: string;
  webUrl?: string;
};

export type GitHubHistoryGit = {
  /**
   * Ensure a commit object is available for reading. Hosts typically
   * `git fetch` missing SHAs. Throw when the object cannot be obtained.
   */
  ensureCommit(sha: string): Promise<string>;
  /** True when `ancestor` is an ancestor of `descendant` (inclusive). */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /** Merge base of two commits, used to recover each historical head's effective target base. */
  mergeBase(left: string, right: string): Promise<string>;
  /** Per-commit patch files for signature-based evolution (required). */
  readCommitDiff(sha: string): Promise<ReadonlyArray<ChangedFile>>;
  /** Metadata for a single commit object. */
  readCommitMeta(sha: string): Promise<GitHubCommitLike>;
  /** Commits exclusive to `base..head`, oldest → newest. */
  readCommitStack(base: string, head: string): Promise<ReadonlyArray<GitHubCommitLike>>;
  /**
   * Materialize a changed-file list for `base...head` (or direct when
   * `symmetric` is false).
   */
  readRangeFiles(
    base: string,
    head: string,
    symmetric: boolean,
  ): Promise<ReadonlyArray<ChangedFile>>;
};

const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * Parse force-push records from the PR timeline / issue events API.
 */
export const normalizeForcePushEvent = (value: unknown): ForcePushEvent | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const event = value as {
    actor?: { login?: unknown };
    after?: unknown;
    after_commit_oid?: unknown;
    before?: unknown;
    before_commit_oid?: unknown;
    commit_id?: unknown;
    commit_oid?: unknown;
    created_at?: unknown;
    createdAt?: unknown;
    event?: unknown;
    payload?: { after?: unknown; before?: unknown };
    type?: unknown;
    user?: { login?: unknown };
  };
  const eventName = String(event.event || event.type || '');
  if (
    eventName !== 'head_ref_force_pushed' &&
    eventName !== 'HeadRefForcePushedEvent' &&
    !(event.commit_id && event.commit_oid)
  ) {
    if (eventName !== 'force-push' && event.event !== 'force-pushed') {
      if (!(typeof event.before === 'string' && typeof event.after === 'string')) {
        return null;
      }
    }
  }

  const before =
    (typeof event.before === 'string' && event.before) ||
    (typeof event.before_commit_oid === 'string' && event.before_commit_oid) ||
    (typeof event.payload?.before === 'string' && event.payload.before) ||
    (typeof event.commit_id === 'string' && event.commit_id) ||
    '';
  const after =
    (typeof event.after === 'string' && event.after) ||
    (typeof event.after_commit_oid === 'string' && event.after_commit_oid) ||
    (typeof event.payload?.after === 'string' && event.payload.after) ||
    (typeof event.commit_oid === 'string' && event.commit_oid) ||
    '';
  const createdAt =
    (typeof event.created_at === 'string' && event.created_at) ||
    (typeof event.createdAt === 'string' && event.createdAt) ||
    new Date(0).toISOString();

  if (!/^[0-9a-f]{7,40}$/i.test(before) || !/^[0-9a-f]{7,40}$/i.test(after)) {
    return null;
  }
  if (before === after) {
    return null;
  }

  return {
    after,
    before,
    createdAt,
    ...(typeof event.actor?.login === 'string'
      ? { actorLogin: event.actor.login }
      : typeof event.user?.login === 'string'
        ? { actorLogin: event.user.login }
        : {}),
  };
};

export const readForcePushTimeline = async ({
  pull,
  transport,
}: {
  pull: GitHubPullRequestRef;
  transport: GitHubTransport;
}): Promise<{
  currentBase: string | null;
  currentHead: string | null;
  events: ReadonlyArray<ForcePushEvent>;
  warning: string | null;
}> => {
  const { number, owner, repo } = pull;
  let warning: string | null = null;
  let events: Array<ForcePushEvent> = [];

  try {
    const timeline = await transport.request<unknown>({
      paginate: true,
      path: `/repos/${owner}/${repo}/issues/${number}/timeline`,
      query: { per_page: 100 },
    });
    const items = Array.isArray(timeline) ? timeline : [];
    events = items
      .map(normalizeForcePushEvent)
      .filter((event): event is ForcePushEvent => event != null);
  } catch (error) {
    warning =
      error instanceof Error
        ? `Force-push timeline unavailable (${error.message}). Showing current head only.`
        : 'Force-push timeline unavailable. Showing current head only.';
  }

  let currentHead: string | null = pull.headSha ?? null;
  let currentBase: string | null = null;
  try {
    const pr = await transport.request<{
      base?: { sha?: unknown };
      head?: { sha?: unknown };
    }>({
      path: `/repos/${owner}/${repo}/pulls/${number}`,
    });
    if (typeof pr?.head?.sha === 'string') {
      currentHead = pr.head.sha;
    }
    if (typeof pr?.base?.sha === 'string') {
      currentBase = pr.base.sha;
    }
  } catch {
    // Keep source headSha if PR metadata fails.
  }

  return { currentBase, currentHead, events, warning };
};

/**
 * Build ordered Core version options from force-push heads + current head.
 * Labels intentionally avoid GitLab v1/v2 numbering.
 */
export const listGitHubReviewVersions = async ({
  git,
  pull,
  transport,
}: {
  git?: GitHubHistoryGit;
  pull: GitHubPullRequestRef;
  transport: GitHubTransport;
}): Promise<{
  versions: ReadonlyArray<ReviewVersionOption>;
  warning: string | null;
}> => {
  const { currentBase, currentHead, events, warning } = await readForcePushTimeline({
    pull,
    transport,
  });
  const heads: Array<{ createdAt: string; label: string; sha: string }> = [];
  const seen = new Set<string>();

  const chronological = [...events].toSorted(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
  for (const event of chronological) {
    if (!seen.has(event.before)) {
      seen.add(event.before);
      heads.push({
        createdAt: event.createdAt,
        label: `Head · ${shortSha(event.before)}`,
        sha: event.before,
      });
    }
    if (!seen.has(event.after)) {
      seen.add(event.after);
      heads.push({
        createdAt: event.createdAt,
        label: `Force-push · ${shortSha(event.after)}`,
        sha: event.after,
      });
    }
  }

  if (currentHead && !seen.has(currentHead)) {
    seen.add(currentHead);
    heads.push({
      createdAt: new Date().toISOString(),
      label: 'Current head',
      sha: currentHead,
    });
  } else if (currentHead) {
    for (let index = heads.length - 1; index >= 0; index -= 1) {
      if (heads[index]!.sha === currentHead) {
        heads[index]!.label = 'Current head';
        break;
      }
    }
  }

  if (heads.length === 0) {
    return {
      versions: [],
      warning: warning ?? 'No force-push head history is available for this pull request.',
    };
  }

  const bases = await Promise.all(
    heads.map(async (head) => {
      if (!currentBase || !git) {
        return currentBase || 'unknown-base';
      }
      try {
        await Promise.all([git.ensureCommit(currentBase), git.ensureCommit(head.sha)]);
        return await git.mergeBase(currentBase, head.sha);
      } catch {
        return currentBase;
      }
    }),
  );

  const versions = heads.map((head, index) => {
    const baseSha = bases[index]!;
    return reviewVersionOption({
      createdAt: head.createdAt,
      id: head.sha,
      isHead: index === heads.length - 1,
      number: index + 1,
      range: diffRange(
        revisionRef(baseSha, commitRevisionLabel(shortSha(baseSha))),
        revisionRef(head.sha, versionRevisionLabel(head.label)),
      ),
      ...(index > 0
        ? {
            previousCreatedAt: heads[index - 1]!.createdAt,
            previousNumber: index,
          }
        : {}),
    });
  });

  return { versions, warning };
};

const toMatcherCommit = (commit: GitHubCommitLike) => ({
  authoredDate: commit.authoredAt,
  authorName: commit.authorName,
  message: commit.message ?? commit.subject,
  parentIds: commit.parentIds,
  sha: commit.sha,
  shortSha: commit.shortSha,
  title: commit.title ?? commit.subject,
  webUrl: commit.webUrl ?? '',
});

const countPatchLines = (files: ReadonlyArray<ChangedFile>) => {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const section of file.sections) {
      for (const line of section.patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          additions += 1;
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          deletions += 1;
        }
      }
    }
  }
  return {
    additions,
    deletions,
    filesChanged: files.length,
  };
};

const BASE_MOVEMENT_COMMIT_LIMIT = 40;

/**
 * Classify target-base movement between two PR head snapshots using local git
 * ancestry + exclusive commit lists (GitLab parity fields).
 */
export const buildBaseMovement = async ({
  fromBase,
  git,
  toBase,
}: {
  fromBase: string;
  git: GitHubHistoryGit;
  toBase: string;
}): Promise<DiffComparisonBaseMovement> => {
  const baseRef = async (sha: string) => {
    try {
      const meta = await git.readCommitMeta(sha);
      return {
        committedAt: meta.authoredAt,
        sha,
        shortSha: meta.shortSha || shortSha(sha),
        ...(meta.webUrl ? { webUrl: meta.webUrl } : {}),
      };
    } catch {
      return {
        committedAt: null,
        sha,
        shortSha: shortSha(sha),
      };
    }
  };

  if (fromBase === toBase || fromBase === 'unknown-base' || toBase === 'unknown-base') {
    const [from, to] = await Promise.all([baseRef(fromBase), baseRef(toBase)]);
    return {
      changed: false,
      commits: [],
      commitsBetween: 0,
      commitTimestampDeltaMs: null,
      diffStat: { additions: 0, deletions: 0, filesChanged: 0 },
      from,
      relationship: 'forward',
      to,
      truncated: false,
    };
  }

  try {
    await Promise.all([git.ensureCommit(fromBase), git.ensureCommit(toBase)]);
    const [from, to, forwardIsAncestor, backwardIsAncestor] = await Promise.all([
      baseRef(fromBase),
      baseRef(toBase),
      git.isAncestor(fromBase, toBase),
      git.isAncestor(toBase, fromBase),
    ]);

    let relationship: DiffComparisonBaseMovement['relationship'] = 'unknown';
    let movementCommits: ReadonlyArray<GitHubCommitLike> = [];
    let truncated = false;
    let commitsBetween: number | null = null;

    if (forwardIsAncestor) {
      relationship = 'forward';
      const stack = await git.readCommitStack(fromBase, toBase);
      truncated = stack.length > BASE_MOVEMENT_COMMIT_LIMIT;
      movementCommits = truncated ? stack.slice(-BASE_MOVEMENT_COMMIT_LIMIT) : stack;
      commitsBetween = truncated ? null : stack.length;
    } else if (backwardIsAncestor) {
      relationship = 'backward';
      const stack = await git.readCommitStack(toBase, fromBase);
      truncated = stack.length > BASE_MOVEMENT_COMMIT_LIMIT;
      movementCommits = truncated ? stack.slice(-BASE_MOVEMENT_COMMIT_LIMIT) : stack;
      commitsBetween = truncated ? null : stack.length;
    } else {
      relationship = 'divergent';
      // Prefer new-base-facing exclusive commits for UI expansion.
      const stack = await git.readCommitStack(fromBase, toBase);
      truncated = stack.length > BASE_MOVEMENT_COMMIT_LIMIT;
      movementCommits = truncated ? stack.slice(-BASE_MOVEMENT_COMMIT_LIMIT) : stack;
      commitsBetween = stack.length;
    }

    let diffStat: DiffComparisonBaseMovement['diffStat'] = null;
    try {
      const files = await git.readRangeFiles(fromBase, toBase, false);
      diffStat = countPatchLines(files);
    } catch {
      // Diffstat is best-effort when objects are shallow.
    }

    const fromTimestamp = from.committedAt ? Date.parse(from.committedAt) : Number.NaN;
    const toTimestamp = to.committedAt ? Date.parse(to.committedAt) : Number.NaN;

    return {
      changed: true,
      commits: movementCommits.map((commit) => ({
        authoredAt: commit.authoredAt,
        authorName: commit.authorName,
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        ...(commit.webUrl ? { webUrl: commit.webUrl } : {}),
      })),
      commitsBetween,
      commitTimestampDeltaMs:
        Number.isFinite(fromTimestamp) && Number.isFinite(toTimestamp)
          ? toTimestamp - fromTimestamp
          : null,
      diffStat,
      from,
      relationship,
      to,
      truncated,
    };
  } catch (error) {
    const [from, to] = await Promise.all([baseRef(fromBase), baseRef(toBase)]);
    return {
      changed: true,
      commits: [],
      commitsBetween: null,
      commitTimestampDeltaMs: null,
      diffStat: null,
      from,
      relationship: 'unknown',
      to,
      truncated: false,
      warning: error instanceof Error ? error.message : 'Base movement details are unavailable.',
    };
  }
};

const buildSignatureEvolution = async ({
  baseCommits = [],
  from,
  git,
  newCommits,
  oldCommits,
  to,
}: {
  baseCommits?: ReadonlyArray<GitHubCommitLike>;
  from: DiffEndpointRef;
  git: GitHubHistoryGit;
  newCommits: ReadonlyArray<GitHubCommitLike>;
  oldCommits: ReadonlyArray<GitHubCommitLike>;
  to: DiffEndpointRef;
}): Promise<ReviewCommitEvolution> => {
  let limitedOld = [...oldCommits];
  let limitedNew = [...newCommits];
  let limitedBase = [...baseCommits];
  const warnings: Array<string> = [];
  const stackCompleteness = { new: true, old: true };
  let baseStackComplete = true;

  if (limitedOld.length > versionCommitStackLimit) {
    limitedOld = limitedOld.slice(-versionCommitStackLimit);
    stackCompleteness.old = false;
    warnings.push(
      `Only the latest ${versionCommitStackLimit} commits from the earlier head were analyzed; unmatched commits remain unclassified.`,
    );
  }
  if (limitedNew.length > versionCommitStackLimit) {
    limitedNew = limitedNew.slice(-versionCommitStackLimit);
    stackCompleteness.new = false;
    warnings.push(
      `Only the latest ${versionCommitStackLimit} commits from the later head were analyzed; unmatched commits remain unclassified.`,
    );
  }
  if (limitedBase.length > versionCommitStackLimit) {
    limitedBase = limitedBase.slice(-versionCommitStackLimit);
    baseStackComplete = false;
    warnings.push(
      `Only the latest ${versionCommitStackLimit} target-base commits were analyzed; earlier commits that moved into the base may remain unclassified.`,
    );
  }

  const sameShas = new Set(
    limitedOld
      .map((commit) => commit.sha)
      .filter(
        (sha) =>
          limitedNew.some((commit) => commit.sha === sha) ||
          limitedBase.some((commit) => commit.sha === sha),
      ),
  );
  const needingSignatures = [...limitedOld, ...limitedNew, ...limitedBase].filter(
    (commit, index, commits) =>
      !sameShas.has(commit.sha) &&
      commits.findIndex((candidate) => candidate.sha === commit.sha) === index,
  );

  const signatures = new Map<string, CommitPatchSignature>();
  const baseCommitShas = new Set(limitedBase.map((commit) => commit.sha));
  let failedSignatureCount = 0;
  let failedBaseSignatureCount = 0;
  for (let index = 0; index < needingSignatures.length; index += versionCommitDiffConcurrency) {
    const batch = needingSignatures.slice(index, index + versionCommitDiffConcurrency);
    await Promise.all(
      batch.map(async (commit) => {
        try {
          const files = await git.readCommitDiff(commit.sha);
          const signature = await createCommitPatchSignature(toMatcherCommit(commit), files);
          signatures.set(commit.sha, signature);
        } catch {
          if (baseCommitShas.has(commit.sha)) {
            failedBaseSignatureCount += 1;
          } else {
            failedSignatureCount += 1;
          }
        }
      }),
    );
  }
  if (failedSignatureCount > 0) {
    warnings.push(
      `Patch details were unavailable for ${failedSignatureCount} ${failedSignatureCount === 1 ? 'commit' : 'commits'}; they remain unclassified rather than being called new or removed.`,
    );
    stackCompleteness.old = false;
    stackCompleteness.new = false;
  }
  if (failedBaseSignatureCount > 0) {
    warnings.push(
      `Patch details were unavailable for ${failedBaseSignatureCount} target-base ${failedBaseSignatureCount === 1 ? 'commit' : 'commits'}; earlier commits are only marked as removed when base evidence is complete.`,
    );
    baseStackComplete = false;
  }

  const evolution = await matchVersionCommitStacks({
    baseCommits: limitedBase.map(toMatcherCommit),
    baseStackComplete,
    from,
    newCommits: limitedNew.map(toMatcherCommit),
    oldCommits: limitedOld.map(toMatcherCommit),
    signatures,
    stackCompleteness,
    to,
    warnings,
  });
  return projectCommitEvolution(evolution);
};

export const compareGitHubReviewVersions = async ({
  git,
  pull: _pull,
  range,
  versions,
}: {
  git: GitHubHistoryGit;
  pull: GitHubPullRequestRef;
  range: { fromId: string; toId: string };
  versions: ReadonlyArray<ReviewVersionOption>;
}): Promise<{
  versionCommitEvolution: ReviewCommitEvolution | null;
  versionCommitEvolutionError: string | null;
  versionCompare: DiffComparisonView;
}> => {
  const from = versions.find((version) => version.id === range.fromId);
  const to = versions.find((version) => version.id === range.toId);
  if (!from || !to) {
    throw new Error('Unknown GitHub head revision for comparison.');
  }

  const fromHead = from.range.head.commitId;
  const toHead = to.range.head.commitId;
  const fromBase = from.range.base.commitId;
  const toBase = to.range.base.commitId;
  const warnings: Array<string> = [];

  await git.ensureCommit(fromHead);
  await git.ensureCommit(toHead);
  if (fromBase !== 'unknown-base') {
    try {
      await git.ensureCommit(fromBase);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  const files = await git.readRangeFiles(fromHead, toHead, false);

  const baseMoved = fromBase !== toBase && fromBase !== 'unknown-base' && toBase !== 'unknown-base';
  const lineStats = countPatchLines(files);
  const addedLines = lineStats.additions;
  const deletedLines = lineStats.deletions;

  let baseMovement: DiffComparisonBaseMovement | undefined;
  if (baseMoved) {
    baseMovement = await buildBaseMovement({ fromBase, git, toBase });
    if (baseMovement.warning) {
      warnings.push(baseMovement.warning);
    }
  }

  const versionCompare = diffComparisonView({
    analysis: {
      summary: {
        addedLines,
        baseMoved,
        commentsAffected: 0,
        conflictFiles: 0,
        deletedLines,
        empty: files.length === 0,
        filesChanged: files.length,
        intentionalFiles: files.length,
        noiseFiles: 0,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(baseMovement ? { baseMovement } : {}),
    },
    comparison: diffComparison(from.range, to.range),
    files,
    from,
    to,
  });

  let versionCommitEvolution: ReviewCommitEvolution | null = null;
  let versionCommitEvolutionError: string | null = null;
  try {
    const stackBase = fromBase !== 'unknown-base' ? fromBase : fromHead;
    const newStackBase = toBase !== 'unknown-base' ? toBase : stackBase;
    const [oldCommits, newCommits, baseCommits] = await Promise.all([
      git.readCommitStack(stackBase, fromHead),
      git.readCommitStack(newStackBase, toHead),
      baseMoved
        ? git.readCommitStack(fromBase, toBase).catch(() => [] as Array<GitHubCommitLike>)
        : Promise.resolve([] as Array<GitHubCommitLike>),
    ]);
    versionCommitEvolution = await buildSignatureEvolution({
      baseCommits,
      from: {
        baseSha: fromBase,
        createdAt: from.createdAt,
        headSha: fromHead,
        id: from.id,
        label: from.range.head.label.text,
        startSha: fromBase,
      },
      git,
      newCommits,
      oldCommits,
      to: {
        baseSha: toBase,
        createdAt: to.createdAt,
        headSha: toHead,
        id: to.id,
        label: to.range.head.label.text,
        startSha: toBase,
      },
    });
  } catch (error) {
    versionCommitEvolutionError = error instanceof Error ? error.message : String(error);
  }

  return {
    versionCommitEvolution,
    versionCommitEvolutionError,
    versionCompare,
  };
};

/**
 * Load a single evolution unit as a commit range diff when possible.
 */
export const loadGitHubVersionCommitUnitDiff = async ({
  git,
  unit,
}: {
  git: GitHubHistoryGit;
  unit: ReviewEvolutionUnit;
}): Promise<ReadonlyArray<ChangedFile>> => {
  if (!unit.reviewable) {
    throw new Error('This commit evolution unit is not reviewable.');
  }
  if (unit.kind === 'introduced' && unit.after) {
    const parent = unit.after.parentIds[0];
    if (!parent) {
      return git.readRangeFiles(`${unit.after.sha}^`, unit.after.sha, false);
    }
    return git.readRangeFiles(parent, unit.after.sha, false);
  }
  if (unit.kind === 'removed' && unit.before) {
    const parent = unit.before.parentIds[0];
    if (!parent) {
      throw new Error('The removed commit parent is unavailable.');
    }
    return git.readRangeFiles(unit.before.sha, parent, false);
  }
  if (unit.kind === 'revised' && unit.before && unit.after) {
    return git.readRangeFiles(unit.before.sha, unit.after.sha, false);
  }
  throw new Error(`Unsupported evolution unit kind for diff loading: ${unit.kind}`);
};

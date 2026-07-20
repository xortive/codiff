/**
 * Read-side GitLab review-history adapter over {@link GitLabTransport}.
 */
import type {
  ChangedFile,
  DiffComparisonAnalysis,
  DiffComparisonView,
  ReviewCommitEvolution,
  ReviewCommitSummary,
  ReviewEvolutionUnit,
  ReviewPlan,
  ReviewVersionOption,
} from '@nkzw/codiff-core/types';
import {
  commitRevisionLabel,
  diffComparison,
  diffComparisonView,
  diffRange,
  resolveReviewPlan,
  reviewVersionOption,
  revisionRef,
  versionRevisionLabel,
} from '@nkzw/codiff-core';
import type { GitLabTransport } from './transport.ts';
import {
  attributeRebaseDrivers,
  createCommitPatchSignature,
  matchVersionCommitStacks,
  versionCommitDiffConcurrency,
  versionCommitStackLimit,
  type CommitPatchSignature,
  type MergeRequestVersionCommitEvolution,
  type VersionCommitEvolutionUnit,
  type VersionRebaseDriverCommit,
} from './version-commit-evolution.ts';
import {
  computeVersionComparePreferringReplay,
  type CommentAnchor,
  type MergeRequestVersionCompare,
  type MergeRequestVersionRef,
  type VersionBaseMovement,
  type VersionCompareEndpoint,
  type VersionPatchFile,
} from './version-compare.ts';

export type { GitLabTransport } from './transport.ts';
export type {
  CommentAnchor,
  MergeRequestVersionCompare,
  MergeRequestVersionRef,
  VersionCompareEndpoint,
  VersionPatchFile,
} from './version-compare.ts';
export type {
  CommitPatchSignature,
  MergeRequestVersionCommitEvolution,
  VersionCommitEvolutionUnit,
  VersionCommitMatchKind,
  VersionCommitSummary,
  VersionRebaseDriverCommit,
} from './version-commit-evolution.ts';
export {
  attributeRebaseDrivers,
  createCommitPatchSignature,
  matchVersionCommitStacks,
  recommendVersionWalkthroughStructure,
  toVersionCommitSummary,
  versionCommitDiffConcurrency,
  versionCommitEvolutionAlgorithmVersion,
  versionCommitSignatureAlgorithmVersion,
  versionCommitStackLimit,
} from './version-commit-evolution.ts';
export {
  applyUnifiedPatchBody,
  computeApproximatePatchTextVersionCompare,
  computeLineDiff,
  computeRebaseReplayVersionCompare,
  computeVersionComparePreferringReplay,
  isMergeRequestVersionRef,
  materializeRebaseReplayTrees,
  versionCompareAlgorithmVersion,
} from './version-compare.ts';
export {
  classifyGitLabCommit,
  classifyMergeRequestReviewStrategy,
  orderCommitsTopologically,
  overrideMergeRequestReviewStrategy,
  reviewStructureFromStrategy,
  versionCompareReviewStructureKey,
  type ClassifiedCommit,
  type ClassifiedCommitRole,
  type GitLabMergeRequestCommitLike,
  type MergeRequestReviewStrategy,
} from './review-strategy.ts';
import { orderCommitsTopologically } from './review-strategy.ts';

const maxPages = 20;

const gitLabOrigin = 'https://gitlab.cfdata.org';

export type GitLabDiffIdentity = {
  baseSha: string;
  headSha: string;
  startSha: string;
};

export type GitLabMergeRequestCommit = {
  authoredDate: string;
  authorEmail: string;
  authorName: string;
  committedDate: string;
  committerName: string;
  message: string;
  parentIds: ReadonlyArray<string>;
  sha: string;
  shortSha: string;
  title: string;
  webUrl: string;
};

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asRecord = (value: unknown): JsonRecord => (isRecord(value) ? value : {});
const asArray = (value: unknown): Array<unknown> => (Array.isArray(value) ? value : []);
const asString = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const asNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const trimmedString = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const validateProjectPath = (projectPath: string) => {
  const normalized = projectPath.trim().replaceAll(/^\/+|\/+$/g, '');
  if (
    !normalized ||
    normalized.length > 500 ||
    !normalized.includes('/') ||
    normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid GitLab project path.');
  }
  return normalized;
};

const mergeRequestEndpoint = (projectPath: string, iid: number, suffix = '') =>
  `${gitLabOrigin}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}${suffix}`;

const mergeRequestCommitsEndpoint = (projectPath: string, iid: number) =>
  mergeRequestEndpoint(projectPath, iid, '/commits');

const mergeRequestVersionsEndpoint = (projectPath: string, iid: number) =>
  mergeRequestEndpoint(projectPath, iid, '/versions');

const mergeRequestVersionEndpoint = (projectPath: string, iid: number, versionId: string) =>
  mergeRequestEndpoint(projectPath, iid, `/versions/${encodeURIComponent(versionId)}`);

const repositoryCompareEndpoint = (projectPath: string, from: string, to: string) => {
  const url = new URL(
    `${gitLabOrigin}/api/v4/projects/${encodeURIComponent(projectPath)}/repository/compare`,
  );
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  url.searchParams.set('straight', 'true');
  return url.toString();
};

const repositoryFileRawEndpoint = (projectPath: string, filePath: string, ref: string) => {
  const url = new URL(
    `${gitLabOrigin}/api/v4/projects/${encodeURIComponent(projectPath)}/repository/files/${encodeURIComponent(filePath)}/raw`,
  );
  url.searchParams.set('ref', ref);
  return url.toString();
};

const repositoryCommitDiffEndpoint = (projectPath: string, sha: string) =>
  `${gitLabOrigin}/api/v4/projects/${encodeURIComponent(projectPath)}/repository/commits/${encodeURIComponent(sha)}/diff`;

const repositoryCommitEndpoint = (projectPath: string, sha: string) =>
  `${gitLabOrigin}/api/v4/projects/${encodeURIComponent(projectPath)}/repository/commits/${encodeURIComponent(sha)}`;







const createRequest = (
  pathOrUrl: string,
  init: { method?: string; headers?: HeadersInit; body?: unknown } = {},
) => {
  // Accept absolute URLs from legacy helpers and reduce to path+query.
  let path = pathOrUrl;
  let query: Record<string, string> | undefined;
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    const url = new URL(pathOrUrl);
    path = url.pathname;
    if (url.searchParams.toString()) {
      query = Object.fromEntries(url.searchParams.entries());
    }
  } else if (pathOrUrl.includes('?')) {
    const url = new URL(pathOrUrl, 'https://gitlab.local');
    path = url.pathname;
    query = Object.fromEntries(url.searchParams.entries());
  }
  return { body: init.body, method: (init.method as any) ?? 'GET', path, query };
};

const readJson = async (
  transport: GitLabTransport,
  request: { path: string; query?: Record<string, string>; method?: any; body?: unknown },
  _unavailableMessage: string,
) => transport.request({
  body: request.body,
  method: request.method,
  path: request.path,
  query: request.query,
});

const readText = async (
  transport: GitLabTransport,
  request: { path: string; query?: Record<string, string> },
) => {
  if (!transport.requestText) {
    throw new Error('GitLabTransport.requestText is required for raw blob reads.');
  }
  return transport.requestText({ path: request.path, query: request.query });
};

const readPages = async (
  transport: GitLabTransport,
  url: string,
): Promise<Array<unknown>> => {
  const first = createRequest(url);
  if (transport.requestPages) {
    return transport.requestPages({ path: first.path, query: first.query });
  }
  const values: Array<unknown> = [];
  let page = 1;
  while (page <= maxPages) {
    const result = await transport.request<unknown>({
      path: first.path,
      query: { ...(first.query ?? {}), page, per_page: 100 },
    });
    const pageValues = asArray(result);
    values.push(...pageValues);
    if (pageValues.length < 100) break;
    page += 1;
  }
  if (page > maxPages) {
    throw new Error('GitLab merge request data exceeded the pagination limit.');
  }
  return values;
};









const createPatch = (diff: JsonRecord) => {
  const oldPath = asString(diff.old_path);
  const newPath = asString(diff.new_path);
  const body = asString(diff.diff);
  const oldHeader = diff.new_file === true ? '/dev/null' : `a/${oldPath}`;
  const newHeader = diff.deleted_file === true ? '/dev/null' : `b/${newPath}`;
  return `diff --git a/${oldPath} b/${newPath}\n--- ${oldHeader}\n+++ ${newHeader}\n${body}${
    body.endsWith('\n') ? '' : '\n'
  }`;
};

const normalizeDiff = (
  diffValue: unknown,
  iid: number,
  headSha: string,
  index: number,
  sectionKind: 'commit' | 'pull-request' = 'pull-request',
  sectionScope: string = String(iid),
): ChangedFile | null => {
  const diff = asRecord(diffValue);
  const oldPath = asString(diff.old_path);
  const newPath = asString(diff.new_path);
  if (!oldPath || !newPath) {
    return null;
  }
  const status = diff.new_file
    ? 'added'
    : diff.deleted_file
      ? 'deleted'
      : diff.renamed_file
        ? 'renamed'
        : 'modified';
  const rawPatch = asString(diff.diff);
  const unavailable = !rawPatch.trim();
  const sectionId = `${newPath}:${sectionKind}:${sectionScope}`;
  return {
    fingerprint: `${headSha}:${index}:${status}:${oldPath}:${newPath}:${rawPatch.length}`,
    ...(oldPath !== newPath ? { oldPath } : {}),
    path: newPath,
    sections: [
      {
        binary: false,
        id: sectionId,
        kind: sectionKind,
        loadState: unavailable ? 'too-large' : 'ready',
        patch: unavailable ? '' : createPatch(diff),
        ...(unavailable
          ? {
              summary: {
                canLoad: false,
                reason:
                  diff.too_large === true
                    ? 'GitLab marked this diff as too large to display.'
                    : 'GitLab did not return a text patch for this file.',
              },
            }
          : {}),
      },
    ],
    status,
  };
};

const normalizeMergeRequestCommit = (
  value: unknown,
  projectPath: string,
): GitLabMergeRequestCommit | null => {
  const commit = asRecord(value);
  const sha = asString(commit.id ?? commit.sha);
  if (!sha) {
    return null;
  }
  const title = asString(commit.title, asString(commit.message).split('\n')[0] || sha.slice(0, 8));
  const message = asString(commit.message, title);
  const shortSha = asString(commit.short_id, sha.slice(0, 8));
  const parentIds = asArray(commit.parent_ids)
    .map((parent) => asString(parent))
    .filter(Boolean);
  const authorName =
    trimmedString(commit.author_name) ?? trimmedString(asRecord(commit.author).name) ?? 'Unknown';
  const authorEmail =
    trimmedString(commit.author_email) ?? trimmedString(asRecord(commit.author).email) ?? '';
  const authoredDate =
    asString(commit.authored_date) ||
    asString(commit.created_at) ||
    asString(commit.committed_date) ||
    new Date(0).toISOString();
  const committerName = trimmedString(commit.committer_name) ?? authorName;
  const committedDate = asString(commit.committed_date) || authoredDate;
  return {
    authoredDate,
    authorEmail,
    authorName,
    committedDate,
    committerName,
    message,
    parentIds,
    sha,
    shortSha,
    title,
    webUrl:
      asString(commit.web_url) ||
      `${gitLabOrigin}/${projectPath}/-/commit/${encodeURIComponent(sha)}`,
  };
};

const normalizeVersionPatchFile = (value: unknown): VersionPatchFile | null => {
  const diff = asRecord(value);
  const oldPath = asString(diff.old_path);
  const newPath = asString(diff.new_path);
  if (!oldPath || !newPath) {
    return null;
  }
  const status = diff.new_file
    ? 'added'
    : diff.deleted_file
      ? 'deleted'
      : diff.renamed_file
        ? 'renamed'
        : 'modified';
  return {
    newPath,
    oldPath,
    patchBody: asString(diff.diff),
    status,
  };
};

const normalizeMergeRequestVersion = (
  value: unknown,
  index: number,
): MergeRequestVersionRef | null => {
  const version = asRecord(value);
  const rawId = version.id;
  const id =
    (typeof rawId === 'string' && rawId) ||
    (typeof rawId === 'number' && Number.isFinite(rawId) ? String(rawId) : String(index + 1));
  const baseSha = asString(version.base_commit_sha);
  const startSha = asString(version.start_commit_sha, baseSha);
  const headSha = asString(version.head_commit_sha);
  if (!baseSha || !headSha) {
    return null;
  }
  const createdAt = asString(version.created_at, new Date(0).toISOString());
  const shortHead = headSha.slice(0, 7);
  return {
    baseSha,
    createdAt,
    headSha,
    id,
    label: `v${id} · ${shortHead}`,
    startSha,
  };
};

// --- Commit / version / version-comparison GitLab surface (Fate root queries call these) ---
// Commits list → client commits mode. Commit diff → lazy onLoadCommitDiff.
// Versions + version comparison → version picker + version-comparison view (algorithm in version-compare.ts).
export const fetchGitLabMergeRequestCommits = async ({
  transport,
  iid,
  projectPath: rawProjectPath,
}: {
  transport: GitLabTransport;
  iid: number;
  projectPath: string;
}): Promise<Array<GitLabMergeRequestCommit>> => {
  const projectPath = validateProjectPath(rawProjectPath);
  if (!Number.isInteger(iid) || iid <= 0) {
    throw new Error('Invalid GitLab merge request IID.');
  }
  const values = await readPages(
    transport,
    mergeRequestCommitsEndpoint(projectPath, iid),
    );
  return values
    .map((value) => normalizeMergeRequestCommit(value, projectPath))
    .filter((commit): commit is GitLabMergeRequestCommit => commit != null);
};

export const fetchGitLabCommitDiff = async ({
  transport,
  projectPath: rawProjectPath,
  sha,
}: {
  transport: GitLabTransport;
  projectPath: string;
  sha: string;
}): Promise<Array<ChangedFile>> => {
  const projectPath = validateProjectPath(rawProjectPath);
  const normalizedSha = sha.trim();
  if (!normalizedSha) {
    throw new Error('A commit SHA is required.');
  }
  const diffs = await readPages(
    transport,
    repositoryCommitDiffEndpoint(projectPath, normalizedSha),
    );
  return diffs
    .map((diff, index) =>
      normalizeDiff(diff, 0, normalizedSha, index, 'commit', normalizedSha.slice(0, 12)),
    )
    .filter((file): file is ChangedFile => file != null)
    .toSorted((first, second) => first.path.localeCompare(second.path));
};

export type MergeRequestVersionDiffStat = {
  additions: number;
  deletions: number;
  filesChanged: number;
};

/**
 * MR-local version history. GitLab's `id` is deliberately retained only for
 * server-side endpoint resolution; URLs use `number` (0 is the MR base).
 */
export type MergeRequestVersionHistoryEntry = {
  createdAt: string | null;
  diffStat: MergeRequestVersionDiffStat;
  headSha: string;
  id: string | null;
  isHead: boolean;
  number: number;
  previousCreatedAt?: string;
  previousNumber?: number;
};

type VersionStatCache = {
  read?: (range: {
    next: MergeRequestVersionRef;
    previous: MergeRequestVersionRef;
  }) => Promise<MergeRequestVersionDiffStat | null> | MergeRequestVersionDiffStat | null;
  write?: (
    range: { next: MergeRequestVersionRef; previous: MergeRequestVersionRef },
    diffStat: MergeRequestVersionDiffStat,
  ) => Promise<void> | void;
};

const readGitLabMergeRequestVersions = async ({
  transport,
  iid,
  projectPath: rawProjectPath,
}: {
  transport: GitLabTransport;
  iid: number;
  projectPath: string;
}): Promise<Array<MergeRequestVersionRef>> => {
  const projectPath = validateProjectPath(rawProjectPath);
  if (!Number.isInteger(iid) || iid <= 0) {
    throw new Error('Invalid GitLab merge request IID.');
  }
  const values = await readPages(
    transport,
    mergeRequestVersionsEndpoint(projectPath, iid),
    );
  return values
    .map((value, index) => normalizeMergeRequestVersion(value, index))
    .filter((version): version is MergeRequestVersionRef => version != null)
    .toSorted((first, second) => {
      const timeDifference = Date.parse(first.createdAt) - Date.parse(second.createdAt);
      return timeDifference || first.id.localeCompare(second.id);
    });
};

/** Versions ordered newest → oldest for existing versionCompare endpoint callers. */
export const fetchGitLabMergeRequestVersions = async (args: {
  transport: GitLabTransport;
  iid: number;
  projectPath: string;
}): Promise<Array<MergeRequestVersionRef>> => {
  const versions = await readGitLabMergeRequestVersions(args);
  return versions.toReversed().map((version, index) => ({
    ...version,
    label: `v${versions.length - index} · ${version.headSha.slice(0, 7)}`,
  }));
};

export const fetchGitLabMergeRequestVersionHistory = async ({
  cache,
  transport,
  iid,
  projectPath,
}: {
  cache?: VersionStatCache;
  transport: GitLabTransport;
  iid: number;
  projectPath: string;
}): Promise<Array<MergeRequestVersionHistoryEntry>> => {
  const versions = await readGitLabMergeRequestVersions({
    transport,
    iid,
    projectPath,
  });
  if (versions.length === 0) {
    return [];
  }
  const stats = await Promise.all(
    versions.map(async (version, index) => {
      const previous =
        versions[index - 1] ??
        ({
          ...version,
          headSha: version.baseSha,
          id: 'base',
          label: 'MR base',
          startSha: version.baseSha,
        } satisfies MergeRequestVersionRef);
      const cached = await cache?.read?.({ next: version, previous });
      if (cached) {
        return cached;
      }
      // GitLab's version endpoint returns the whole MR patch for that version,
      // not the delta from the preceding version. Compare the two endpoint
      // SHAs so this is genuinely v(N-1) → vN (and base → v1).
      const files = await readCompareFiles({
        from: previous.headSha,
        transport,
        projectPath,
        to: version.headSha,
      });
      const diffStat = {
        additions: files.reduce(
          (total, file) =>
            total +
            file.patchBody
              .split('\n')
              .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
          0,
        ),
        deletions: files.reduce(
          (total, file) =>
            total +
            file.patchBody
              .split('\n')
              .filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
          0,
        ),
        filesChanged: files.length,
      };
      await cache?.write?.({ next: version, previous }, diffStat);
      return diffStat;
    }),
  );
  const first = versions[0];
  return [
    {
      createdAt: null,
      diffStat: stats[0]!,
      headSha: first.baseSha,
      id: null,
      isHead: false,
      number: 0,
    },
    ...versions.map((version, index) => ({
      createdAt: version.createdAt,
      diffStat: stats[index]!,
      headSha: version.headSha,
      id: version.id,
      isHead: index === versions.length - 1,
      number: index + 1,
      ...(index > 0
        ? { previousCreatedAt: versions[index - 1]!.createdAt, previousNumber: index }
        : {}),
    })),
  ];
};

const readMergeRequestVersionFiles = async ({
  transport,
  iid,
  projectPath,
  versionId,
}: {
  transport: GitLabTransport;
  iid: number;
  projectPath: string;
  versionId: string;
}): Promise<Array<VersionPatchFile>> => {
  const value = await readJson(
    transport,
    createRequest(mergeRequestVersionEndpoint(projectPath, iid, versionId)),
    'Unable to load the merge request version.',
  );
  const version = asRecord(value);
  return asArray(version.diffs ?? version.changes)
    .map(normalizeVersionPatchFile)
    .filter((file): file is VersionPatchFile => file != null);
};
const readRepositoryCompare = async ({
  from,
  transport,
  projectPath,
  to,
}: {
  from: string;
  transport: GitLabTransport;
  projectPath: string;
  to: string;
}): Promise<JsonRecord> =>
  asRecord(
    await readJson(
      transport,
      createRequest(repositoryCompareEndpoint(projectPath, from, to)),
      'Unable to compare GitLab revisions.',
    ),
  );

const readCompareFiles = async (args: {
  from: string;
  transport: GitLabTransport;
  projectPath: string;
  to: string;
}): Promise<Array<VersionPatchFile>> => {
  const value = await readRepositoryCompare(args);
  return asArray(value.diffs)
    .map(normalizeVersionPatchFile)
    .filter((file): file is VersionPatchFile => file != null);
};

const getPatchDiffStat = (files: ReadonlyArray<VersionPatchFile>) => ({
  additions: files.reduce(
    (total, file) =>
      total +
      file.patchBody.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .length,
    0,
  ),
  deletions: files.reduce(
    (total, file) =>
      total +
      file.patchBody.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'))
        .length,
    0,
  ),
  filesChanged: files.length,
});

const commitGraphReaches = (
  targetSha: string,
  ancestorSha: string,
  candidates: ReadonlyArray<GitLabMergeRequestCommit>,
) => {
  const bySha = new Map(candidates.map((commit) => [commit.sha, commit]));
  const visit = (sha: string, visited = new Set<string>()): boolean => {
    if (sha === ancestorSha) {
      return true;
    }
    if (visited.has(sha)) {
      return false;
    }
    visited.add(sha);
    return (bySha.get(sha)?.parentIds ?? []).some((parent) => visit(parent, visited));
  };
  return visit(targetSha);
};

const toBaseMovementCommit = (commit: GitLabMergeRequestCommit) => ({
  authoredAt: commit.authoredDate,
  authorName: commit.authorName,
  sha: commit.sha,
  shortSha: commit.shortSha,
  subject: commit.title,
  webUrl: commit.webUrl,
});

const readBaseMovement = async ({
  fromSha,
  transport,
  projectPath,
  toSha,
}: {
  fromSha: string;
  transport: GitLabTransport;
  projectPath: string;
  toSha: string;
}): Promise<VersionBaseMovement> => {
  const baseRef = (sha: string, value?: unknown) => {
    const commit = asRecord(value);
    return {
      committedAt: trimmedString(commit.committed_date) ?? null,
      sha,
      shortSha: trimmedString(commit.short_id) ?? sha.slice(0, 7),
      webUrl:
        trimmedString(commit.web_url) ??
        `${gitLabOrigin}/${projectPath}/-/commit/${encodeURIComponent(sha)}`,
    };
  };
  if (fromSha === toSha) {
    return {
      changed: false,
      commits: [],
      commitsBetween: 0,
      commitTimestampDeltaMs: null,
      diffStat: { additions: 0, deletions: 0, filesChanged: 0 },
      from: baseRef(fromSha),
      relationship: 'forward',
      to: baseRef(toSha),
      truncated: false,
    };
  }
  try {
    const [fromValue, toValue, compare] = await Promise.all([
      readJson(
        transport,
        createRequest(repositoryCommitEndpoint(projectPath, fromSha)),
        'Unable to load the old base commit.',
      ),
      readJson(
        transport,
        createRequest(repositoryCommitEndpoint(projectPath, toSha)),
        'Unable to load the new base commit.',
      ),
      readRepositoryCompare({ from: fromSha, transport, projectPath, to: toSha }),
    ]);
    const from = baseRef(fromSha, fromValue);
    const to = baseRef(toSha, toValue);
    const commits = asArray(compare.commits)
      .map((value) => normalizeMergeRequestCommit(value, projectPath))
      .filter((commit): commit is GitLabMergeRequestCommit => commit != null);
    const forwardTruncated = compare.compare_timeout === true || compare.overflow === true;
    let relationship: VersionBaseMovement['relationship'] = commitGraphReaches(
      toSha,
      fromSha,
      commits,
    )
      ? 'forward'
      : 'unknown';
    // Prefer the new-base-facing commit list for UI expansion. For a pure
    // backward base move, fall back to the reverse compare list.
    let movementCommits = commits.map(toBaseMovementCommit);
    let commitsBetween = relationship === 'forward' && !forwardTruncated ? commits.length : null;
    let truncated = forwardTruncated;
    if (relationship === 'unknown' && !forwardTruncated) {
      try {
        const reverse = await readRepositoryCompare({
          from: toSha,
          transport,
          projectPath,
          to: fromSha,
        });
        const reverseCommits = asArray(reverse.commits)
          .map((value) => normalizeMergeRequestCommit(value, projectPath))
          .filter((commit): commit is GitLabMergeRequestCommit => commit != null);
        const reverseTruncated = reverse.compare_timeout === true || reverse.overflow === true;
        truncated = reverseTruncated;
        if (commitGraphReaches(fromSha, toSha, reverseCommits)) {
          relationship = 'backward';
          movementCommits = reverseCommits.map(toBaseMovementCommit);
          commitsBetween = reverseTruncated ? null : reverseCommits.length;
        } else if (!reverseTruncated) {
          relationship = 'divergent';
          // From→to still describes the new base tip relative to the old one.
          // Count those commits even when the histories diverged, so the UI can
          // show base-diff stats and an expandable commit list.
          commitsBetween = commits.length;
        }
      } catch {
        relationship = 'unknown';
      }
    } else if (relationship === 'unknown' && forwardTruncated && commits.length > 0) {
      // GitLab may still return a partial commit list when compare overflows.
      commitsBetween = commits.length;
    }
    const files = asArray(compare.diffs)
      .map(normalizeVersionPatchFile)
      .filter((file): file is VersionPatchFile => file != null);
    const fromTimestamp = from.committedAt ? Date.parse(from.committedAt) : Number.NaN;
    const toTimestamp = to.committedAt ? Date.parse(to.committedAt) : Number.NaN;
    return {
      changed: true,
      commits: movementCommits,
      commitsBetween,
      commitTimestampDeltaMs:
        Number.isFinite(fromTimestamp) && Number.isFinite(toTimestamp)
          ? toTimestamp - fromTimestamp
          : null,
      diffStat: getPatchDiffStat(files),
      from,
      relationship,
      to,
      truncated,
    };
  } catch (error) {
    return {
      changed: true,
      commits: [],
      commitsBetween: null,
      commitTimestampDeltaMs: null,
      diffStat: null,
      from: baseRef(fromSha),
      relationship: 'unknown',
      to: baseRef(toSha),
      truncated: false,
      warning: error instanceof Error ? error.message : 'Base movement details are unavailable.',
    };
  }
};

const resolveVersionCompareEndpoint = ({
  comments,
  endpoint,
  lastReviewed,
  versions,
}: {
  comments?: ReadonlyArray<CommentAnchor>;
  endpoint: VersionCompareEndpoint;
  lastReviewed?: MergeRequestVersionRef | null;
  versions: ReadonlyArray<MergeRequestVersionRef>;
}): MergeRequestVersionRef => {
  if (endpoint.kind === 'mr-base') {
    const oldest = versions.at(-1);
    if (!oldest) {
      throw new Error('No merge request base is available.');
    }
    return {
      ...oldest,
      headSha: oldest.baseSha,
      id: 'base',
      label: 'MR base',
      startSha: oldest.baseSha,
    };
  }
  if (endpoint.kind === 'mr-version') {
    const match = versions.find((version) => version.id === endpoint.versionId);
    if (!match) {
      throw new Error(`Unknown merge request version: ${endpoint.versionId}`);
    }
    return match;
  }
  if (endpoint.kind === 'diff-identity') {
    return {
      baseSha: endpoint.baseSha,
      createdAt: new Date(0).toISOString(),
      headSha: endpoint.headSha,
      id: `identity:${endpoint.headSha}`,
      label: endpoint.headSha.slice(0, 7),
      startSha: endpoint.startSha,
    };
  }
  if (endpoint.kind === 'head-sha') {
    const match = versions.find((version) => version.headSha === endpoint.headSha);
    if (match) {
      return match;
    }
    return {
      baseSha: versions[0]?.baseSha ?? endpoint.headSha,
      createdAt: new Date(0).toISOString(),
      headSha: endpoint.headSha,
      id: `head:${endpoint.headSha}`,
      label: endpoint.headSha.slice(0, 7),
      startSha: versions[0]?.startSha ?? versions[0]?.baseSha ?? endpoint.headSha,
    };
  }
  if (endpoint.kind === 'last-reviewed') {
    if (!lastReviewed) {
      throw new Error('No last-reviewed identity is available for this merge request.');
    }
    return lastReviewed;
  }
  if (endpoint.kind === 'comment-position') {
    const match = (comments ?? []).find((comment) => comment.commentId === endpoint.commentId);
    if (!match) {
      throw new Error(`Unknown comment position for version comparison: ${endpoint.commentId}`);
    }
    const byHead = versions.find((version) => version.headSha === match.position.headSha);
    if (byHead) {
      return byHead;
    }
    return {
      baseSha: match.position.baseSha,
      createdAt: new Date(0).toISOString(),
      headSha: match.position.headSha,
      id: `comment:${endpoint.commentId}`,
      label: `comment ${endpoint.commentId} · ${match.position.headSha.slice(0, 7)}`,
      startSha: match.position.startSha,
    };
  }
  throw new Error('Unsupported version-comparison endpoint.');
};

const collectCommentAnchorsFromDiscussions = (
  discussions: ReadonlyArray<unknown>,
): Array<CommentAnchor> =>
  discussions.flatMap((discussionValue) => {
    const discussion = asRecord(discussionValue);
    return asArray(discussion.notes).flatMap((noteValue) => {
      const note = asRecord(noteValue);
      if (note.system === true) {
        return [];
      }
      const position = asRecord(note.position ?? note.original_position);
      const filePath = asString(position.new_path ?? position.old_path);
      const baseSha = asString(position.base_sha);
      const startSha = asString(position.start_sha);
      const headSha = asString(position.head_sha);
      const id = asNumber(note.id);
      if (!filePath || !baseSha || !startSha || !headSha || id == null || !Number.isInteger(id)) {
        return [];
      }
      const rawLine = asNumber(position.new_line ?? position.old_line);
      const anchor: CommentAnchor = {
        commentId: `gitlab:${id}`,
        filePath,
        position: { baseSha, headSha, startSha },
      };
      if (rawLine != null && Number.isInteger(rawLine) && rawLine > 0) {
        anchor.lineNumber = rawLine;
      }
      return [anchor];
    });
  });

export const fetchGitLabMergeRequestVersionCompare = async ({
  comments = [],
  from: fromEndpoint,
  transport,
  iid,
  lastReviewed = null,
  paths,
  projectPath: rawProjectPath,
  readCached,
  to: toEndpoint,
  writeCached,
}: {
  comments?: ReadonlyArray<CommentAnchor>;
  from: VersionCompareEndpoint;
  transport: GitLabTransport;
  iid: number;
  lastReviewed?: MergeRequestVersionRef | null;
  paths?: ReadonlyArray<string>;
  projectPath: string;
  readCached?: (range: {
    from: MergeRequestVersionRef;
    to: MergeRequestVersionRef;
  }) => Promise<MergeRequestVersionCompare | null> | MergeRequestVersionCompare | null;
  to: VersionCompareEndpoint;
  writeCached?: (versionCompare: MergeRequestVersionCompare) => Promise<void> | void;
}): Promise<MergeRequestVersionCompare> => {
  const projectPath = validateProjectPath(rawProjectPath);
  if (!Number.isInteger(iid) || iid <= 0) {
    throw new Error('Invalid GitLab merge request IID.');
  }
  const needsCommentAnchors =
    comments.length === 0 ||
    fromEndpoint.kind === 'comment-position' ||
    toEndpoint.kind === 'comment-position';
  const [versions, discussionAnchors] = await Promise.all([
    fetchGitLabMergeRequestVersions({
      transport,
      iid,
      projectPath,
    }),
    needsCommentAnchors
      ? readPages(
          transport,
          mergeRequestEndpoint(projectPath, iid, '/discussions'),
          ).then(collectCommentAnchorsFromDiscussions)
      : Promise.resolve([] as Array<CommentAnchor>),
  ]);
  if (versions.length === 0) {
    throw new Error('GitLab did not return merge request versions for version comparison.');
  }
  const resolvedComments = comments.length > 0 ? comments : discussionAnchors;
  const from = resolveVersionCompareEndpoint({
    comments: resolvedComments,
    endpoint: fromEndpoint,
    lastReviewed,
    versions,
  });
  const to = resolveVersionCompareEndpoint({
    comments: resolvedComments,
    endpoint: toEndpoint,
    lastReviewed,
    versions,
  });
  if (from.headSha === to.headSha && from.baseSha === to.baseSha) {
    throw new Error('Version comparison requires distinct from and to endpoints.');
  }
  if (readCached) {
    const cached = await readCached({ from, to });
    if (cached) {
      return cached;
    }
  }

  const baseMovementPromise = readBaseMovement({
    fromSha: from.baseSha,
    transport,
    projectPath,
    toSha: to.baseSha,
  });

  const loadVersionFiles = async (version: MergeRequestVersionRef) => {
    const listed = versions.find((candidate) => candidate.id === version.id);
    if (listed) {
      try {
        return await readMergeRequestVersionFiles({
          transport,
          iid,
          projectPath,
          versionId: version.id,
        });
      } catch {
        // Fall through to repository compare.
      }
    }
    return readCompareFiles({
      from: version.baseSha,
      transport,
      projectPath,
      to: version.headSha,
    });
  };

  const [fromFiles, toFiles] = await Promise.all([loadVersionFiles(from), loadVersionFiles(to)]);
  const blobCache = new Map<string, string | null>();
  const readBlob = async (filePath: string, ref: string) => {
    const key = `${ref}:${filePath}`;
    if (blobCache.has(key)) {
      return blobCache.get(key) ?? null;
    }
    try {
      const content = await readText(
        transport,
        createRequest(repositoryFileRawEndpoint(projectPath, filePath, ref), {
          headers: { accept: 'text/plain' },
        }),
      );
      blobCache.set(key, content);
      return content;
    } catch {
      blobCache.set(key, null);
      return null;
    }
  };
  const computedVersionCompare = await computeVersionComparePreferringReplay({
    comments: resolvedComments,
    from,
    fromFiles,
    paths,
    readBlob,
    to,
    toFiles,
  });
  const versionCompare: MergeRequestVersionCompare = {
    ...computedVersionCompare,
    baseMovement: await baseMovementPromise,
  };
  if (writeCached) {
    try {
      await writeCached(versionCompare);
    } catch {
      // Cache writes are best-effort.
    }
  }
  return versionCompare;
};

const resolveVersionCommitRange = async ({
  from,
  transport,
  iid,
  projectPath,
  to,
}: {
  from: VersionCompareEndpoint;
  transport: GitLabTransport;
  iid: number;
  projectPath: string;
  to: VersionCompareEndpoint;
}) => {
  const versions =
    from.kind === 'diff-identity' && to.kind === 'diff-identity'
      ? []
      : await fetchGitLabMergeRequestVersions({
          transport,
          iid,
          projectPath,
        });
  if (versions.length === 0 && (from.kind !== 'diff-identity' || to.kind !== 'diff-identity')) {
    throw new Error('GitLab did not return merge request versions.');
  }
  return {
    from: resolveVersionCompareEndpoint({ endpoint: from, versions }),
    to: resolveVersionCompareEndpoint({ endpoint: to, versions }),
  };
};

export const fetchGitLabHistoricalCommitStack = async ({
  baseSha,
  transport,
  headSha,
  projectPath: rawProjectPath,
}: {
  baseSha: string;
  transport: GitLabTransport;
  headSha: string;
  projectPath: string;
}): Promise<Array<GitLabMergeRequestCommit>> => {
  if (baseSha === headSha) {
    return [];
  }
  const projectPath = validateProjectPath(rawProjectPath);
  const compare = await readRepositoryCompare({
    from: baseSha,
    transport,
    projectPath,
    to: headSha,
  });
  if (compare.compare_timeout === true || compare.overflow === true) {
    throw new Error('GitLab truncated the historical commit stack.');
  }
  const commits = asArray(compare.commits)
    .map((value) => normalizeMergeRequestCommit(value, projectPath))
    .filter(
      (commit): commit is GitLabMergeRequestCommit => commit != null && commit.sha !== baseSha,
    );
  return [...orderCommitsTopologically(commits)];
};

const readCommitPatchFiles = async ({
  transport,
  projectPath,
  sha,
}: {
  transport: GitLabTransport;
  projectPath: string;
  sha: string;
}) => {
  const values = await readPages(
    transport,
    repositoryCommitDiffEndpoint(projectPath, sha),
    );
  return values
    .map(normalizeVersionPatchFile)
    .filter((file): file is VersionPatchFile => file != null);
};

const scopeVersionCommitFiles = (
  files: ReadonlyArray<ChangedFile>,
  unitId: string,
): Array<ChangedFile> =>
  files.map((file, fileIndex) => ({
    ...file,
    fingerprint: `${unitId}:${fileIndex}:${file.fingerprint}`,
    sections: file.sections.map((section, sectionIndex) => ({
      ...section,
      id: `${file.path}:version-commit:${unitId}:${sectionIndex}`,
    })),
  }));

type VersionCommitSignatureCache = {
  read?: (sha: string) => Promise<CommitPatchSignature | null> | CommitPatchSignature | null;
  write?: (signature: CommitPatchSignature) => Promise<void> | void;
};

export const fetchGitLabMergeRequestVersionCommitEvolution = async ({
  cache,
  from: fromEndpoint,
  transport,
  iid,
  projectPath: rawProjectPath,
  to: toEndpoint,
}: {
  cache?: VersionCommitSignatureCache;
  from: VersionCompareEndpoint;
  transport: GitLabTransport;
  iid: number;
  projectPath: string;
  to: VersionCompareEndpoint;
}): Promise<MergeRequestVersionCommitEvolution> => {
  const projectPath = validateProjectPath(rawProjectPath);
  const range = await resolveVersionCommitRange({
    from: fromEndpoint,
    transport,
    iid,
    projectPath,
    to: toEndpoint,
  });
  const warnings: Array<string> = [];
  const [oldStackResult, newStackResult, baseStackResult] = await Promise.allSettled([
    fetchGitLabHistoricalCommitStack({
      baseSha: range.from.baseSha,
      transport,
      headSha: range.from.headSha,
      projectPath,
    }),
    fetchGitLabHistoricalCommitStack({
      baseSha: range.to.baseSha,
      transport,
      headSha: range.to.headSha,
      projectPath,
    }),
    range.from.baseSha === range.to.baseSha
      ? Promise.resolve([])
      : fetchGitLabHistoricalCommitStack({
          baseSha: range.from.baseSha,
          transport,
          headSha: range.to.baseSha,
          projectPath,
        }),
  ]);
  const stackCompleteness = {
    new: newStackResult.status === 'fulfilled',
    old: oldStackResult.status === 'fulfilled',
  };
  let baseStackComplete = baseStackResult.status === 'fulfilled';
  let oldCommits = oldStackResult.status === 'fulfilled' ? oldStackResult.value : [];
  let newCommits = newStackResult.status === 'fulfilled' ? newStackResult.value : [];
  let baseCommits = baseStackResult.status === 'fulfilled' ? baseStackResult.value : [];
  if (!stackCompleteness.old) {
    warnings.push(
      'The earlier commit stack is unavailable. Visible commits remain unclassified rather than being called new.',
    );
  }
  if (!stackCompleteness.new) {
    warnings.push(
      'The later commit stack is unavailable. Visible commits remain unclassified rather than being called removed.',
    );
  }
  if (baseStackResult.status !== 'fulfilled') {
    warnings.push(
      'Target-base movement could not be analyzed. Earlier commits that moved into the base remain unclassified.',
    );
  }
  if (oldCommits.length > versionCommitStackLimit) {
    oldCommits = oldCommits.slice(-versionCommitStackLimit);
    stackCompleteness.old = false;
    warnings.push(
      `Only the latest ${versionCommitStackLimit} commits from the earlier version were analyzed; unmatched commits remain unclassified.`,
    );
  }
  if (newCommits.length > versionCommitStackLimit) {
    newCommits = newCommits.slice(-versionCommitStackLimit);
    stackCompleteness.new = false;
    warnings.push(
      `Only the latest ${versionCommitStackLimit} commits from the later version were analyzed; unmatched commits remain unclassified.`,
    );
  }
  if (baseCommits.length > versionCommitStackLimit) {
    baseCommits = baseCommits.slice(-versionCommitStackLimit);
    baseStackComplete = false;
    warnings.push(
      `Only the latest ${versionCommitStackLimit} target-base commits were analyzed; earlier commits that moved into the base may remain unclassified.`,
    );
  }
  const sameShas = new Set(
    oldCommits
      .map((commit) => commit.sha)
      .filter(
        (sha) =>
          newCommits.some((commit) => commit.sha === sha) ||
          baseCommits.some((commit) => commit.sha === sha),
      ),
  );
  const commitsNeedingSignatures = [...oldCommits, ...newCommits, ...baseCommits].filter(
    (commit, index, commits) =>
      !sameShas.has(commit.sha) &&
      commits.findIndex((candidate) => candidate.sha === commit.sha) === index,
  );
  const signatures = new Map<string, CommitPatchSignature>();
  const baseCommitShas = new Set(baseCommits.map((commit) => commit.sha));
  let failedBaseSignatureCount = 0;
  let failedSignatureCount = 0;
  for (
    let index = 0;
    index < commitsNeedingSignatures.length;
    index += versionCommitDiffConcurrency
  ) {
    const batch = commitsNeedingSignatures.slice(index, index + versionCommitDiffConcurrency);
    await Promise.all(
      batch.map(async (commit) => {
        try {
          const cached = await cache?.read?.(commit.sha);
          if (cached) {
            signatures.set(commit.sha, cached);
            return;
          }
        } catch {
          // A missing/stale cache must not prevent direct analysis.
        }
        try {
          const files = await fetchGitLabCommitDiff({
            transport,
            projectPath,
            sha: commit.sha,
          });
          const signature = await createCommitPatchSignature(commit, files);
          signatures.set(commit.sha, signature);
          try {
            await cache?.write?.(signature);
          } catch {
            // Immutable signature cache writes are best-effort.
          }
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
      `Patch details were unavailable for ${failedBaseSignatureCount} target-base ${failedBaseSignatureCount === 1 ? 'commit' : 'commits'}; earlier MR commits are only marked as removed when base evidence is complete.`,
    );
    baseStackComplete = false;
  }
  return matchVersionCommitStacks({
    baseCommits,
    baseStackComplete,
    from: range.from,
    newCommits,
    oldCommits,
    signatures,
    stackCompleteness,
    to: range.to,
    warnings,
  });
};

export const attributeVersionCommitRebaseDrivers = async ({
  baseCommits,
  transport,
  projectPath,
  unit,
  unitFiles,
}: {
  baseCommits: ReadonlyArray<{
    authoredAt: string;
    authorName: string;
    sha: string;
    shortSha: string;
    subject: string;
    webUrl: string;
  }>;
  transport: GitLabTransport;
  projectPath: string;
  unit: VersionCommitEvolutionUnit;
  unitFiles: ReadonlyArray<ChangedFile>;
}): Promise<ReadonlyArray<VersionRebaseDriverCommit>> => {
  if (unit.kind !== 'likely-revised' || baseCommits.length === 0 || unitFiles.length === 0) {
    return unit.rebaseDrivers ?? [];
  }
  const unitSignature = await createCommitPatchSignature(
    {
      sha: unit.after?.sha ?? unit.before?.sha ?? unit.id,
      title: unit.after?.subject ?? unit.before?.subject ?? unit.id,
    },
    unitFiles,
  );
  const signatures = new Map<string, CommitPatchSignature>();
  // Cap base-commit signature work; large base moves are common on revived MRs.
  const candidates = baseCommits.slice(0, 40);
  for (let index = 0; index < candidates.length; index += versionCommitDiffConcurrency) {
    const batch = candidates.slice(index, index + versionCommitDiffConcurrency);
    await Promise.all(
      batch.map(async (commit) => {
        try {
          const files = await fetchGitLabCommitDiff({
            transport,
            projectPath,
            sha: commit.sha,
          });
          signatures.set(
            commit.sha,
            await createCommitPatchSignature({ sha: commit.sha, title: commit.subject }, files),
          );
        } catch {
          // Skip unreadable base commits rather than failing the unit walkthrough.
        }
      }),
    );
  }
  return attributeRebaseDrivers({
    baseCommits: candidates,
    baseSignatures: signatures,
    unitSignature,
  });
};

export const fetchGitLabVersionCommitUnitDiff = async ({
  transport,
  projectPath: rawProjectPath,
  unit,
}: {
  transport: GitLabTransport;
  projectPath: string;
  unit: VersionCommitEvolutionUnit;
}): Promise<Array<ChangedFile>> => {
  const projectPath = validateProjectPath(rawProjectPath);
  if (!unit.reviewable) {
    throw new Error('This commit evolution unit is not reviewable.');
  }
  if (unit.kind === 'added' && unit.after) {
    return scopeVersionCommitFiles(
      await fetchGitLabCommitDiff({ transport, projectPath, sha: unit.after.sha }),
      unit.id,
    );
  }
  if (unit.kind === 'removed' && unit.before) {
    const parent = unit.before.parentIds[0];
    if (!parent) {
      throw new Error('The removed commit parent is unavailable.');
    }
    const compare = await readRepositoryCompare({
      from: unit.before.sha,
      transport,
      projectPath,
      to: parent,
    });
    return scopeVersionCommitFiles(
      asArray(compare.diffs)
        .map((diff, index) => normalizeDiff(diff, 0, parent, index, 'commit', unit.id))
        .filter((file): file is ChangedFile => file != null),
      unit.id,
    );
  }
  if (unit.kind === 'likely-revised' && unit.before && unit.after) {
    const oldParent = unit.before.parentIds[0];
    const newParent = unit.after.parentIds[0];
    if (!oldParent || !newParent) {
      throw new Error('A revised commit parent is unavailable.');
    }
    const [fromFiles, toFiles] = await Promise.all([
      readCommitPatchFiles({ transport, projectPath, sha: unit.before.sha }),
      readCommitPatchFiles({ transport, projectPath, sha: unit.after.sha }),
    ]);
    const blobs = new Map<string, string | null>();
    const readBlob = async (filePath: string, ref: string) => {
      const key = `${ref}:${filePath}`;
      if (blobs.has(key)) {
        return blobs.get(key) ?? null;
      }
      try {
        const content = await readText(
          transport,
          createRequest(repositoryFileRawEndpoint(projectPath, filePath, ref), {
            headers: { accept: 'text/plain' },
          }),
        );
        blobs.set(key, content);
        return content;
      } catch {
        blobs.set(key, null);
        return null;
      }
    };
    const comparison = await computeVersionComparePreferringReplay({
      from: {
        baseSha: oldParent,
        createdAt: unit.before.authoredAt,
        headSha: unit.before.sha,
        id: unit.before.sha,
        label: unit.before.shortSha,
        startSha: oldParent,
      },
      fromFiles,
      readBlob,
      to: {
        baseSha: newParent,
        createdAt: unit.after.authoredAt,
        headSha: unit.after.sha,
        id: unit.after.sha,
        label: unit.after.shortSha,
        startSha: newParent,
      },
      toFiles,
    });
    return scopeVersionCommitFiles(
      comparison.files.map((file) => file.file),
      unit.id,
    );
  }
  throw new Error('Unsupported commit evolution unit.');
};

export const projectMergeRequestVersionRef = (
  version: MergeRequestVersionRef & { number?: number; createdAt?: string; diffStat?: ReviewVersionOption['diffStat']; isHead?: boolean; previousCreatedAt?: string; previousNumber?: number },
): ReviewVersionOption =>
  reviewVersionOption({
    createdAt: version.createdAt,
    id: version.id,
    range: diffRange(
      revisionRef(version.baseSha, commitRevisionLabel(version.baseSha.slice(0, 7))),
      revisionRef(
        version.headSha,
        versionRevisionLabel(version.label, undefined),
      ),
    ),
    ...(version.diffStat ? { diffStat: version.diffStat } : {}),
    ...(version.isHead != null ? { isHead: version.isHead } : {}),
    ...(version.number != null ? { number: version.number } : {}),
    ...(version.previousCreatedAt ? { previousCreatedAt: version.previousCreatedAt } : {}),
    ...(version.previousNumber != null ? { previousNumber: version.previousNumber } : {}),
  });

const projectCommitSummary = (commit: Algorithmish | undefined): ReviewCommitSummary | undefined => {
  if (!commit) return undefined;
  return {
    authorName: commit.authorName,
    authoredAt: commit.authoredAt,
    parentIds: commit.parentIds ?? [],
    sha: commit.sha,
    shortSha: commit.shortSha,
    subject: commit.subject,
    webUrl: commit.webUrl,
    ...(commit.diffStat ? { diffStat: commit.diffStat } : {}),
  };
};

type Algorithmish = {
  authorName: string;
  authoredAt: string;
  diffStat?: { additions: number; deletions: number; filesChanged: number };
  parentIds?: ReadonlyArray<string>;
  sha: string;
  shortSha: string;
  subject: string;
  webUrl?: string;
};

export const projectEvolutionUnit = (unit: {
  after?: Algorithmish;
  baseCommit?: Algorithmish;
  before?: Algorithmish;
  confidence: 'exact' | 'high' | 'unmatched';
  id: string;
  kind: string;
  matchReasons?: ReadonlyArray<string>;
  matchScore?: number;
  order: number;
  rebaseDrivers?: ReadonlyArray<{
    authorName: string;
    authoredAt: string;
    overlappingPaths: ReadonlyArray<string>;
    sha: string;
    shortSha: string;
    subject: string;
    webUrl?: string;
  }>;
  reviewable: boolean;
}): ReviewEvolutionUnit => {
  const common = {
    confidence: unit.confidence,
    id: unit.id,
    order: unit.order,
    ...(unit.matchReasons ? { matchReasons: unit.matchReasons } : {}),
    ...(unit.matchScore != null ? { matchScore: unit.matchScore } : {}),
  } as const;
  if (unit.kind === 'added' || unit.kind === 'introduced') {
    return {
      ...common,
      after: projectCommitSummary(unit.after)!,
      kind: 'introduced',
      reviewable: true,
    };
  }
  if (unit.kind === 'removed') {
    return {
      ...common,
      before: projectCommitSummary(unit.before)!,
      kind: 'removed',
      reviewable: true,
    };
  }
  if (unit.kind === 'likely-revised' || unit.kind === 'revised') {
    return {
      ...common,
      after: projectCommitSummary(unit.after)!,
      before: projectCommitSummary(unit.before)!,
      kind: 'revised',
      reviewable: true,
      ...(unit.rebaseDrivers
        ? {
            rebaseDrivers: unit.rebaseDrivers.map((driver) => ({
              authorName: driver.authorName,
              authoredAt: driver.authoredAt,
              overlappingPaths: driver.overlappingPaths,
              sha: driver.sha,
              shortSha: driver.shortSha,
              subject: driver.subject,
              webUrl: driver.webUrl,
            })),
          }
        : {}),
    };
  }
  if (unit.kind === 'ambiguous') {
    return {
      ...common,
      kind: 'ambiguous',
      reviewable: true,
      ...(projectCommitSummary(unit.after) ? { after: projectCommitSummary(unit.after) } : {}),
      ...(projectCommitSummary(unit.before) ? { before: projectCommitSummary(unit.before) } : {}),
    };
  }
  if (unit.kind === 'absorbed-into-base') {
    return {
      ...common,
      kind: 'absorbed-into-base',
      reviewable: false,
      ...(projectCommitSummary(unit.after) ? { after: projectCommitSummary(unit.after) } : {}),
      ...(projectCommitSummary(unit.baseCommit) ? { baseCommit: projectCommitSummary(unit.baseCommit) } : {}),
      ...(projectCommitSummary(unit.before) ? { before: projectCommitSummary(unit.before) } : {}),
    };
  }
  // retained / rewritten-same-patch
  return {
    ...common,
    kind: unit.kind === 'rewritten-same-patch' ? 'rewritten-same-patch' : 'retained',
    reviewable: false,
    ...(projectCommitSummary(unit.after) ? { after: projectCommitSummary(unit.after) } : {}),
    ...(projectCommitSummary(unit.before) ? { before: projectCommitSummary(unit.before) } : {}),
  };
};

export const projectCommitEvolution = (
  evolution: MergeRequestVersionCommitEvolution,
): ReviewCommitEvolution => ({
  recommendation: {
    rationale: evolution.recommendation.reason,
    suggestedStructure: evolution.recommendation.structure,
  },
  summary: evolution.summary,
  units: evolution.units.map(projectEvolutionUnit),
  ...(evolution.warnings ? { warnings: evolution.warnings } : {}),
});

export const projectVersionCompare = (
  compare: MergeRequestVersionCompare,
  files: ReadonlyArray<ChangedFile> = compare.files.map((file) => file.file),
): DiffComparisonView => {
  const from = projectMergeRequestVersionRef(compare.range.from);
  const to = projectMergeRequestVersionRef(compare.range.to);
  const analysis: DiffComparisonAnalysis = {
    summary: compare.summary,
    ...(compare.baseMovement ? { baseMovement: compare.baseMovement } : {}),
    ...(compare.commentAssociations
      ? { commentAssociations: compare.commentAssociations }
      : {}),
    ...(compare.warnings ? { warnings: compare.warnings } : {}),
  };
  return diffComparisonView({
    analysis,
    comparison: diffComparison(from.range, to.range),
    files,
    from,
    to,
  });
};

export const projectReviewPlan = ({
  evolution,
  structure,
  versionCompare,
}: {
  evolution?: MergeRequestVersionCommitEvolution | ReviewCommitEvolution | null;
  structure?: 'auto' | 'commit-by-commit' | 'whole-diff' | 'units';
  versionCompare?: MergeRequestVersionCompare | DiffComparisonView | null;
}): ReviewPlan => {
  const projectedEvolution =
    evolution && 'recommendation' in evolution && 'reason' in (evolution as MergeRequestVersionCommitEvolution).recommendation
      ? projectCommitEvolution(evolution as MergeRequestVersionCommitEvolution)
      : (evolution as ReviewCommitEvolution | undefined);
  const view =
    versionCompare && 'range' in versionCompare
      ? projectVersionCompare(versionCompare)
      : (versionCompare as DiffComparisonView | undefined);
  const analysis = view
    ? {
        ...view.analysis,
        ...(projectedEvolution ? { commitEvolution: projectedEvolution } : {}),
      }
    : projectedEvolution
      ? {
          commitEvolution: projectedEvolution,
          summary: {
            addedLines: 0,
            baseMoved: false,
            commentsAffected: 0,
            conflictFiles: 0,
            deletedLines: 0,
            empty: false,
            filesChanged: 0,
            intentionalFiles: 0,
            noiseFiles: 0,
          },
        }
      : undefined;
  return resolveReviewPlan({
    analysis,
    comparison: view?.comparison,
    recommendation: projectedEvolution?.recommendation,
    structure,
    units: projectedEvolution?.units,
  });
};

export const toGitLabDiffIdentity = (version: MergeRequestVersionRef): GitLabDiffIdentity => ({
  baseSha: version.baseSha,
  headSha: version.headSha,
  startSha: version.startSha,
});

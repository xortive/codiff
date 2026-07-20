// Merge-request version-comparison algorithm.
// Orchestration entry: computeVersionComparePreferringReplay()
//   → materializeRebaseReplayTrees + computeRebaseReplayVersionCompare (preferred)
//   → computeApproximatePatchTextVersionCompare (fallback when blobs missing)
// GitLab I/O + endpoint resolution live in merge-request.ts (fetchGitLabMergeRequestVersionCompare).
// Fate query: gitLabMergeRequestVersionCompare in server/src/fate/server.ts.
// See PLAN.md §G2.

// Version-comparison control flow inspired by Jujutsu (jj) rebase_to_dest_parent +
// show_inter_diff (Apache-2.0). Clean-room TypeScript reimplementation;
// no jj source is vendored.

// === Localized line diff (bounded Myers O(ND) algorithm) ===

const MAX_DIFF_D = 1000;

type DiffEdit = {
  kind: 'delete' | 'equal' | 'insert';
  line: string;
};

/**
 * Compute the shortest edit script between two line arrays using Myers' O(ND) algorithm.
 * Returns null if the edit distance exceeds maxD (pathological input).
 */
const myersEditScript = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  maxD = MAX_DIFF_D,
): ReadonlyArray<DiffEdit> | null => {
  const N = a.length;
  const M = b.length;

  if (N === 0 && M === 0) {
    return [];
  }
  if (N === 0) {
    return b.map((line) => ({ kind: 'insert' as const, line }));
  }
  if (M === 0) {
    return a.map((line) => ({ kind: 'delete' as const, line }));
  }
  // Minimum possible edit distance is |N-M|; bail early if already too large.
  if (Math.abs(N - M) > maxD) {
    return null;
  }

  const MAX = Math.min(N + M, maxD);
  const offset = MAX;
  const size = 2 * MAX + 1;
  const v = new Int32Array(size);
  const trace: Array<Int32Array> = [];
  let solved = false;

  for (let d = 0; d <= MAX; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
        x = v[k + 1 + offset]!;
      } else {
        x = v[k - 1 + offset]! + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= N && y >= M) {
        solved = true;
        break;
      }
    }
    if (solved) {
      break;
    }
  }

  if (!solved) {
    return null;
  }

  // Backtrack to build edit script.
  let x = N;
  let y = M;
  const edits: Array<DiffEdit> = [];

  for (let d = trace.length - 1; d > 0; d--) {
    const vPrev = trace[d]!;
    const k = x - y;

    let prevK: number;
    if (k === -d || (k !== d && vPrev[k - 1 + offset]! < vPrev[k + 1 + offset]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = vPrev[prevK + offset]!;
    const prevY = prevX - prevK;

    // Diagonal (equal) moves from after-edit position to current (x, y).
    const afterEditX = prevK === k + 1 ? prevX : prevX + 1;
    while (x > afterEditX) {
      x--;
      y--;
      edits.push({ kind: 'equal', line: a[x]! });
    }

    // The edit itself.
    if (prevK === k + 1) {
      edits.push({ kind: 'insert', line: b[prevY]! });
    } else {
      edits.push({ kind: 'delete', line: a[prevX]! });
    }

    x = prevX;
    y = prevY;
  }

  // Initial snake (d=0): remaining diagonals from (0,0).
  while (x > 0) {
    x--;
    y--;
    edits.push({ kind: 'equal', line: a[x]! });
  }

  edits.reverse();
  return edits;
};

/**
 * Format an edit script as unified diff hunks with limited context lines.
 * Returns an empty string when the edit script contains no changes.
 */
const formatUnifiedHunks = (
  edits: ReadonlyArray<DiffEdit>,
  leftEndsWithNewline: boolean,
  rightEndsWithNewline: boolean,
  contextLines = 3,
): string => {
  // Find positions of changes.
  const changePositions: Array<number> = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i]!.kind !== 'equal') {
      changePositions.push(i);
    }
  }
  if (changePositions.length === 0) {
    return '';
  }

  // Group changes into hunk ranges [start, end) with context.
  const hunkRanges: Array<[number, number]> = [];
  let hunkStart = Math.max(0, changePositions[0]! - contextLines);
  let hunkEnd = changePositions[0]! + 1;

  for (let i = 1; i < changePositions.length; i++) {
    const pos = changePositions[i]!;
    if (pos <= hunkEnd + 2 * contextLines) {
      hunkEnd = pos + 1;
    } else {
      hunkRanges.push([hunkStart, Math.min(edits.length, hunkEnd + contextLines)]);
      hunkStart = Math.max(0, pos - contextLines);
      hunkEnd = pos + 1;
    }
  }
  hunkRanges.push([hunkStart, Math.min(edits.length, hunkEnd + contextLines)]);

  // Pre-compute old/new line numbers at each edit position.
  const oldLineAt: Array<number> = [];
  const newLineAt: Array<number> = [];
  let oln = 1;
  let nln = 1;
  for (let i = 0; i < edits.length; i++) {
    oldLineAt.push(oln);
    newLineAt.push(nln);
    const kind = edits[i]!.kind;
    if (kind === 'equal' || kind === 'delete') {
      oln++;
    }
    if (kind === 'equal' || kind === 'insert') {
      nln++;
    }
  }
  const totalOldLines = oln - 1;
  const totalNewLines = nln - 1;

  // Format each hunk.
  const output: Array<string> = [];
  for (const [start, end] of hunkRanges) {
    const hunkEdits = edits.slice(start, end);
    const oldStart = oldLineAt[start]!;
    const newStart = newLineAt[start]!;
    let oldCount = 0;
    let newCount = 0;
    const body: Array<string> = [];

    for (let i = 0; i < hunkEdits.length; i++) {
      const edit = hunkEdits[i]!;
      if (edit.kind === 'equal') {
        body.push(` ${edit.line}`);
        oldCount++;
        newCount++;
        // Check for no-newline marker on the last line of both files.
        if (
          oldLineAt[start + i]! === totalOldLines &&
          newLineAt[start + i]! === totalNewLines &&
          !leftEndsWithNewline &&
          !rightEndsWithNewline
        ) {
          body.push(String.raw`\ No newline at end of file`);
        }
      } else if (edit.kind === 'delete') {
        body.push(`-${edit.line}`);
        oldCount++;
        // No-newline marker for last old line.
        if (oldLineAt[start + i]! === totalOldLines && !leftEndsWithNewline) {
          body.push(String.raw`\ No newline at end of file`);
        }
      } else {
        body.push(`+${edit.line}`);
        newCount++;
        // No-newline marker for last new line.
        if (newLineAt[start + i]! === totalNewLines && !rightEndsWithNewline) {
          body.push(String.raw`\ No newline at end of file`);
        }
      }
    }

    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    output.push(...body);
  }

  return output.join('\n') + '\n';
};

/**
 * Compute a localized unified diff between two file contents.
 * Returns `{ patchBody, incomplete }`.
 * `incomplete` is true when the edit distance exceeds the bounded cap,
 * in which case `patchBody` is empty and the caller should fall back.
 */
export const computeLineDiff = (
  left: string,
  right: string,
  contextLines = 3,
): { incomplete: boolean; patchBody: string } => {
  if (left === right) {
    return { incomplete: false, patchBody: '' };
  }

  const leftLines = left.length === 0 ? [] : left.replace(/\n$/, '').split('\n');
  const rightLines = right.length === 0 ? [] : right.replace(/\n$/, '').split('\n');

  const editScript = myersEditScript(leftLines, rightLines);
  if (!editScript) {
    return { incomplete: true, patchBody: '' };
  }

  const leftEndsWithNewline = left.length > 0 && left.endsWith('\n');
  const rightEndsWithNewline = right.length > 0 && right.endsWith('\n');
  const patchBody = formatUnifiedHunks(
    editScript,
    leftEndsWithNewline,
    rightEndsWithNewline,
    contextLines,
  );

  return { incomplete: false, patchBody };
};

// === Bounded concurrency pool ===

const poolMap = async <T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
};

import type { ChangedFile } from '@nkzw/codiff-core/types';

export type MergeRequestVersionRef = {
  baseSha: string;
  createdAt: string;
  headSha: string;
  id: string;
  label: string;
  startSha: string;
};

export type VersionCompareEndpoint =
  | { kind: 'mr-base' }
  | { commentId: string; kind: 'comment-position' }
  | { baseSha: string; headSha: string; kind: 'diff-identity'; startSha: string }
  | { headSha: string; kind: 'head-sha' }
  | { kind: 'last-reviewed' }
  | { kind: 'mr-version'; versionId: string };

export type VersionCompareRange = {
  from: MergeRequestVersionRef;
  paths?: ReadonlyArray<string>;
  to: MergeRequestVersionRef;
};

export type VersionCompareHunkClass =
  | 'comment-anchored'
  | 'conflict-resolution'
  | 'intentional'
  | 'rebase-noise';

export type VersionCompareFile = {
  classes: ReadonlyArray<VersionCompareHunkClass>;
  file: ChangedFile;
  oldPath?: string;
  path: string;
  relatedCommentIds: ReadonlyArray<string>;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'unchanged-noise';
};

export type VersionBaseRef = {
  committedAt: string | null;
  sha: string;
  shortSha: string;
  webUrl?: string;
};

export type VersionBaseMovementCommit = {
  authoredAt: string;
  authorName: string;
  sha: string;
  shortSha: string;
  subject: string;
  webUrl: string;
};

export type VersionBaseMovement = {
  changed: boolean;
  commits: ReadonlyArray<VersionBaseMovementCommit>;
  commitsBetween: number | null;
  commitTimestampDeltaMs: number | null;
  diffStat: {
    additions: number;
    deletions: number;
    filesChanged: number;
  } | null;
  from: VersionBaseRef;
  relationship: 'forward' | 'backward' | 'divergent' | 'unknown';
  to: VersionBaseRef;
  truncated: boolean;
  warning?: string;
};

export type MergeRequestVersionCompare = {
  algorithm: 'approximate-patch-text' | 'jj-rebase-replay';
  baseMovement?: VersionBaseMovement;
  commentAssociations: ReadonlyArray<{
    commentId: string;
    filePath?: string;
    status: 'newly-anchored' | 'outdated' | 'resolved-by-change' | 'still-valid';
  }>;
  files: ReadonlyArray<VersionCompareFile>;
  range: VersionCompareRange;
  summary: {
    addedLines: number;
    baseMoved: boolean;
    commentsAffected: number;
    conflictFiles: number;
    deletedLines: number;
    empty: boolean;
    filesChanged: number;
    intentionalFiles: number;
    noiseFiles: number;
  };
  warnings?: ReadonlyArray<string>;
};

const getVersionCompareLineStats = (files: ReadonlyArray<VersionCompareFile>) => {
  let addedLines = 0;
  let deletedLines = 0;
  for (const file of files) {
    for (const section of file.file.sections) {
      for (const line of section.patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          addedLines += 1;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          deletedLines += 1;
        }
      }
    }
  }
  return { addedLines, deletedLines };
};

export type VersionPatchFile = {
  newPath: string;
  oldPath: string;
  patchBody: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
};

export type CommentAnchor = {
  commentId: string;
  filePath: string;
  lineNumber?: number;
  position: {
    baseSha: string;
    headSha: string;
    startSha: string;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hashString = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
};

const normalizePatchBody = (patchBody: string) =>
  patchBody
    .split('\n')
    .filter((line) => line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))
    .map((line) => line.replace(/^./, (prefix) => prefix))
    .join('\n')
    .trim();

const changeRegionFingerprint = (patchBody: string) => {
  const changes = patchBody
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++') &&
        !line.startsWith('---'),
    )
    .map((line) => line.slice(1).trimEnd())
    .filter(Boolean);
  return hashString(changes.join('\n'));
};

const createChangedFile = (
  path: string,
  oldPath: string | undefined,
  status: ChangedFile['status'],
  patchBody: string,
  headSha: string,
  kind: 'version-compare' | 'conflict' = 'version-compare',
): ChangedFile => {
  const sectionId = `${path}:commit:version-compare`;
  const headerOld = status === 'added' ? '/dev/null' : `a/${oldPath ?? path}`;
  const headerNew = status === 'deleted' ? '/dev/null' : `b/${path}`;
  const patch = `diff --git a/${oldPath ?? path} b/${path}\n--- ${headerOld}\n+++ ${headerNew}\n${patchBody}${
    patchBody.endsWith('\n') ? '' : '\n'
  }`;
  return {
    fingerprint: `${headSha}:${kind}:${status}:${oldPath ?? path}:${path}:${patch.length}`,
    ...(oldPath && oldPath !== path ? { oldPath } : {}),
    path,
    sections: [
      {
        binary: false,
        id: sectionId,
        kind: 'commit',
        loadState: 'ready',
        patch,
      },
    ],
    status,
  };
};

const pathKey = (file: VersionPatchFile) => file.newPath || file.oldPath;

const pairFiles = (
  fromFiles: ReadonlyArray<VersionPatchFile>,
  toFiles: ReadonlyArray<VersionPatchFile>,
) => {
  const fromByPath = new Map(fromFiles.map((file) => [pathKey(file), file]));
  const toByPath = new Map(toFiles.map((file) => [pathKey(file), file]));
  const paths = new Set([...fromByPath.keys(), ...toByPath.keys()]);
  return [...paths]
    .toSorted((first, second) => first.localeCompare(second))
    .map((path) => ({
      from: fromByPath.get(path) ?? null,
      path,
      to: toByPath.get(path) ?? null,
    }));
};

type PatchRegion = {
  body: string;
  newEnd: number;
  newStart: number;
  oldEnd: number;
  oldStart: number;
};

const patchRegions = (patch: string): ReadonlyArray<PatchRegion> => {
  const matches = [...patch.matchAll(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@.*$/gm)];
  return matches.map((match, index) => {
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? 1);
    const newStart = Number(match[3]);
    const newCount = Number(match[4] ?? 1);
    return {
      body: patch.slice(match.index! + match[0].length, matches[index + 1]?.index ?? patch.length),
      newEnd: newStart + Math.max(0, newCount - 1),
      newStart,
      oldEnd: oldStart + Math.max(0, oldCount - 1),
      oldStart,
    };
  });
};

const regionAtLine = (patch: string, lineNumber: number) =>
  patchRegions(patch).find(
    (region) =>
      (lineNumber >= region.newStart - 2 && lineNumber <= region.newEnd + 2) ||
      (lineNumber >= region.oldStart - 2 && lineNumber <= region.oldEnd + 2),
  );

const commentRegionChanged = (
  fromPatch: string | undefined,
  toPatch: string | undefined,
  lineNumber: number,
) => {
  const before = fromPatch ? regionAtLine(fromPatch, lineNumber) : undefined;
  const after = toPatch ? regionAtLine(toPatch, lineNumber) : undefined;
  if (!before && !after) {
    return false;
  }
  if (before && !after && toPatch) {
    const beforeBody = normalizePatchBody(before.body);
    return !patchRegions(toPatch).some(
      (candidate) => normalizePatchBody(candidate.body) === beforeBody,
    );
  }
  if (after && !before && fromPatch) {
    const afterBody = normalizePatchBody(after.body);
    return !patchRegions(fromPatch).some(
      (candidate) => normalizePatchBody(candidate.body) === afterBody,
    );
  }
  if (!before || !after) {
    return true;
  }
  return normalizePatchBody(before.body) !== normalizePatchBody(after.body);
};

const commentContentWindowChanged = (
  before: string | undefined,
  after: string | undefined,
  lineNumber: number,
) => {
  if (before == null || after == null) {
    return before !== after;
  }
  const start = Math.max(0, lineNumber - 3);
  const end = lineNumber + 2;
  return (
    before.split('\n').slice(start, end).join('\n') !==
    after.split('\n').slice(start, end).join('\n')
  );
};

const classifyCommentAssociations = (
  comments: ReadonlyArray<CommentAnchor>,
  intentionalPaths: ReadonlySet<string>,
  from: MergeRequestVersionRef,
  to: MergeRequestVersionRef,
  addressedCommentIds: ReadonlySet<string> = new Set(),
) =>
  comments.map((comment) => {
    const onFrom =
      comment.position.headSha === from.headSha ||
      comment.position.baseSha === from.baseSha ||
      comment.position.startSha === from.startSha;
    const pathTouched = intentionalPaths.has(comment.filePath);
    if (!onFrom) {
      return {
        commentId: comment.commentId,
        filePath: comment.filePath,
        status: pathTouched ? ('newly-anchored' as const) : ('still-valid' as const),
      };
    }
    if (addressedCommentIds.has(comment.commentId)) {
      return {
        commentId: comment.commentId,
        filePath: comment.filePath,
        status: 'resolved-by-change' as const,
      };
    }
    if (pathTouched) {
      return {
        commentId: comment.commentId,
        filePath: comment.filePath,
        status: 'outdated' as const,
      };
    }
    if (comment.position.headSha === to.headSha) {
      return {
        commentId: comment.commentId,
        filePath: comment.filePath,
        status: 'still-valid' as const,
      };
    }
    return {
      commentId: comment.commentId,
      filePath: comment.filePath,
      status: 'still-valid' as const,
    };
  });

/**
 * Approximate jj version comparison when only patch text is available:
 * compare the logical change regions of each version's MR patch.
 * Pure rebases (identical change regions) produce an empty intentional set.
 */
export const computeApproximatePatchTextVersionCompare = ({
  comments = [],
  from,
  fromFiles,
  paths,
  to,
  toFiles,
}: {
  comments?: ReadonlyArray<CommentAnchor>;
  from: MergeRequestVersionRef;
  fromFiles: ReadonlyArray<VersionPatchFile>;
  paths?: ReadonlyArray<string>;
  to: MergeRequestVersionRef;
  toFiles: ReadonlyArray<VersionPatchFile>;
}): MergeRequestVersionCompare => {
  const pathFilter = paths?.length ? new Set(paths) : null;
  const pairs = pairFiles(fromFiles, toFiles).filter(
    (pair) => pathFilter == null || pathFilter.has(pair.path),
  );
  const files: Array<VersionCompareFile> = [];
  const warnings: Array<string> = [];
  const addressedCommentIds = new Set<string>();
  const baseMoved = from.baseSha !== to.baseSha;

  for (const pair of pairs) {
    for (const comment of comments) {
      if (
        comment.filePath === pair.path &&
        comment.lineNumber != null &&
        commentRegionChanged(pair.from?.patchBody, pair.to?.patchBody, comment.lineNumber)
      ) {
        addressedCommentIds.add(comment.commentId);
      }
    }
    if (!pair.from && pair.to) {
      files.push({
        classes: ['intentional'],
        file: createChangedFile(
          pair.to.newPath,
          pair.to.oldPath,
          pair.to.status,
          pair.to.patchBody,
          to.headSha,
        ),
        oldPath: pair.to.oldPath !== pair.to.newPath ? pair.to.oldPath : undefined,
        path: pair.path,
        relatedCommentIds: comments
          .filter((comment) => comment.filePath === pair.path)
          .map((comment) => comment.commentId),
        status: pair.to.status,
      });
      continue;
    }
    if (pair.from && !pair.to) {
      files.push({
        classes: ['intentional'],
        file: createChangedFile(
          pair.from.newPath,
          pair.from.oldPath,
          'deleted',
          pair.from.patchBody,
          to.headSha,
        ),
        oldPath: pair.from.oldPath !== pair.from.newPath ? pair.from.oldPath : undefined,
        path: pair.path,
        relatedCommentIds: comments
          .filter((comment) => comment.filePath === pair.path)
          .map((comment) => comment.commentId),
        status: 'deleted',
      });
      continue;
    }
    if (!pair.from || !pair.to) {
      continue;
    }

    const fromFingerprint = changeRegionFingerprint(pair.from.patchBody);
    const toFingerprint = changeRegionFingerprint(pair.to.patchBody);
    if (fromFingerprint === toFingerprint) {
      // Pure rebase / identical logical patch — hide by default.
      continue;
    }

    // Prefer the newer version's patch body as the visible versionCompare surface.
    // When both exist and differ, mark intentional; if markers look conflicted,
    // flag conflict-resolution.
    const conflictLike =
      pair.to.patchBody.includes('<<<<<<<') ||
      pair.to.patchBody.includes('>>>>>>>') ||
      pair.from.patchBody.includes('<<<<<<<');
    const classes: Array<VersionCompareHunkClass> = conflictLike
      ? ['conflict-resolution', 'intentional']
      : ['intentional'];
    if (
      baseMoved &&
      normalizePatchBody(pair.from.patchBody) === normalizePatchBody(pair.to.patchBody)
    ) {
      // Safety net: identical normalized text after base move.
      continue;
    }
    if (baseMoved && fromFingerprint !== toFingerprint && !conflictLike) {
      // Approximate path only — note degraded fidelity for consumers.
      warnings.push(
        `Approximate version comparison for ${pair.path} (could not replay onto new base).`,
      );
    }
    files.push({
      classes,
      file: createChangedFile(
        pair.to.newPath,
        pair.to.oldPath,
        pair.to.status,
        pair.to.patchBody,
        to.headSha,
        conflictLike ? 'conflict' : 'version-compare',
      ),
      oldPath: pair.to.oldPath !== pair.to.newPath ? pair.to.oldPath : undefined,
      path: pair.path,
      relatedCommentIds: comments
        .filter((comment) => comment.filePath === pair.path)
        .map((comment) => comment.commentId),
      status: pair.to.status,
    });
  }

  const intentionalPaths = new Set(
    files
      .filter(
        (file) =>
          file.classes.includes('intentional') || file.classes.includes('conflict-resolution'),
      )
      .map((file) => file.path),
  );
  const commentAssociations = classifyCommentAssociations(
    comments,
    intentionalPaths,
    from,
    to,
    addressedCommentIds,
  );
  const intentionalFiles = files.filter((file) => file.classes.includes('intentional')).length;
  const conflictFiles = files.filter((file) => file.classes.includes('conflict-resolution')).length;

  return {
    algorithm: 'approximate-patch-text',
    commentAssociations,
    files,
    range: {
      from,
      ...(paths?.length ? { paths } : {}),
      to,
    },
    summary: {
      ...getVersionCompareLineStats(files),
      baseMoved,
      commentsAffected: commentAssociations.filter((item) => item.status !== 'still-valid').length,
      conflictFiles,
      empty: files.length === 0,
      filesChanged: files.length,
      intentionalFiles,
      noiseFiles: 0,
    },
    ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
  };
};

/**
 * jj-faithful control flow when left/right trees (path→content) are available:
 * left = from tree when bases match, else apply from-patch onto to-base;
 * versionCompare = diff(left, right=to tree).
 */
export const computeRebaseReplayVersionCompare = ({
  comments = [],
  from,
  fromTree,
  paths,
  to,
  toTree,
}: {
  comments?: ReadonlyArray<CommentAnchor>;
  from: MergeRequestVersionRef;
  fromTree: ReadonlyMap<string, string>;
  paths?: ReadonlyArray<string>;
  to: MergeRequestVersionRef;
  toTree: ReadonlyMap<string, string>;
}): MergeRequestVersionCompare & { incompleteDiffPaths: ReadonlyArray<string> } => {
  const pathFilter = paths?.length ? new Set(paths) : null;
  const allPaths = new Set([...fromTree.keys(), ...toTree.keys()]);
  const files: Array<VersionCompareFile> = [];
  const incompleteDiffPaths: Array<string> = [];
  const addressedCommentIds = new Set<string>();
  const baseMoved = from.baseSha !== to.baseSha;

  for (const path of [...allPaths].toSorted((a, b) => a.localeCompare(b))) {
    if (pathFilter && !pathFilter.has(path)) {
      continue;
    }
    const left = fromTree.get(path);
    const right = toTree.get(path);
    if (left === right) {
      continue;
    }
    for (const comment of comments) {
      if (
        comment.filePath === path &&
        comment.lineNumber != null &&
        commentContentWindowChanged(left, right, comment.lineNumber)
      ) {
        addressedCommentIds.add(comment.commentId);
      }
    }
    if (left == null && right != null) {
      files.push({
        classes: ['intentional'],
        file: createChangedFile(
          path,
          undefined,
          'added',
          `@@ -0,0 +1,${right.split('\n').length} @@\n${right
            .split('\n')
            .map((line) => `+${line}`)
            .join('\n')}\n`,
          to.headSha,
        ),
        path,
        relatedCommentIds: comments
          .filter((comment) => comment.filePath === path)
          .map((comment) => comment.commentId),
        status: 'added',
      });
      continue;
    }
    if (left != null && right == null) {
      files.push({
        classes: ['intentional'],
        file: createChangedFile(
          path,
          path,
          'deleted',
          `@@ -1,${left.split('\n').length} +0,0 @@\n${left
            .split('\n')
            .map((line) => `-${line}`)
            .join('\n')}\n`,
          to.headSha,
        ),
        path,
        relatedCommentIds: comments
          .filter((comment) => comment.filePath === path)
          .map((comment) => comment.commentId),
        status: 'deleted',
      });
      continue;
    }
    if (left == null || right == null) {
      continue;
    }
    const conflictLike = left.includes('<<<<<<<') || right.includes('<<<<<<<');
    const diff = computeLineDiff(left, right);
    if (diff.incomplete) {
      incompleteDiffPaths.push(path);
      continue;
    }
    if (!diff.patchBody) {
      // computeLineDiff determined the files are identical after line splitting.
      continue;
    }
    files.push({
      classes: conflictLike ? ['conflict-resolution', 'intentional'] : ['intentional'],
      file: createChangedFile(
        path,
        path,
        'modified',
        diff.patchBody,
        to.headSha,
        conflictLike ? 'conflict' : 'version-compare',
      ),
      path,
      relatedCommentIds: comments
        .filter((comment) => comment.filePath === path)
        .map((comment) => comment.commentId),
      status: 'modified',
    });
  }

  const intentionalPaths = new Set(files.map((file) => file.path));
  const commentAssociations = classifyCommentAssociations(
    comments,
    intentionalPaths,
    from,
    to,
    addressedCommentIds,
  );

  return {
    algorithm: 'jj-rebase-replay',
    commentAssociations,
    files,
    incompleteDiffPaths,
    range: {
      from,
      ...(paths?.length ? { paths } : {}),
      to,
    },
    summary: {
      ...getVersionCompareLineStats(files),
      baseMoved,
      commentsAffected: commentAssociations.filter((item) => item.status !== 'still-valid').length,
      conflictFiles: files.filter((file) => file.classes.includes('conflict-resolution')).length,
      empty: files.length === 0,
      filesChanged: files.length,
      intentionalFiles: files.length,
      noiseFiles: 0,
    },
  };
};

export const versionCompareAlgorithmVersion = 'jj-rebase-replay-v4';

export type BlobLookup = (path: string, ref: string) => Promise<string | null> | string | null;

const parseHunkHeader = (line: string) => {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return null;
  }
  return {
    newCount: match[4] == null ? 1 : Number(match[4]),
    newStart: Number(match[3]),
    oldCount: match[2] == null ? 1 : Number(match[2]),
    oldStart: Number(match[1]),
  };
};

/** Apply a unified-diff body (no git headers) onto source text. Returns conflict markers on mismatch. */
export const applyUnifiedPatchBody = (
  source: string,
  patchBody: string,
): { conflict: boolean; text: string } => {
  const sourceLines = source.length === 0 ? [] : source.replace(/\n$/, '').split('\n');
  const patchLines = patchBody.replace(/\n$/, '').split('\n');
  const output: Array<string> = [];
  let sourceIndex = 0;
  let cursor = 0;
  let conflict = false;

  while (cursor < patchLines.length) {
    const header = parseHunkHeader(patchLines[cursor] ?? '');
    if (!header) {
      cursor += 1;
      continue;
    }
    cursor += 1;
    const oldStart = Math.max(0, header.oldStart - 1);
    while (sourceIndex < oldStart && sourceIndex < sourceLines.length) {
      output.push(sourceLines[sourceIndex] ?? '');
      sourceIndex += 1;
    }
    while (cursor < patchLines.length) {
      const line = patchLines[cursor] ?? '';
      if (line.startsWith('@@')) {
        break;
      }
      cursor += 1;
      if (line.startsWith('\\')) {
        continue;
      }
      const prefix = line[0] ?? ' ';
      const content = line.slice(1);
      if (prefix === ' ' || prefix === '-') {
        const expected = sourceLines[sourceIndex];
        if (expected !== content) {
          conflict = true;
          // Materialize a conflict block and skip remaining hunk application for this file.
          const remainingSource = sourceLines.slice(sourceIndex).join('\n');
          const remainingPatch = patchLines.slice(cursor - 1).join('\n');
          return {
            conflict: true,
            text: `${output.join('\n')}${output.length ? '\n' : ''}<<<<<<< source\n${remainingSource}\n=======\n${remainingPatch}\n>>>>>>> patch\n`,
          };
        }
        if (prefix === ' ') {
          output.push(content);
        }
        sourceIndex += 1;
      } else if (prefix === '+') {
        output.push(content);
      }
    }
  }
  while (sourceIndex < sourceLines.length) {
    output.push(sourceLines[sourceIndex] ?? '');
    sourceIndex += 1;
  }
  const text = output.join('\n');
  return {
    conflict,
    text:
      source.endsWith('\n') || text.length === 0
        ? `${text}${text.length ? '\n' : ''}`
        : `${text}\n`,
  };
};

const collectVersionComparePaths = ({
  comments = [],
  fromFiles,
  paths,
  toFiles,
}: {
  comments?: ReadonlyArray<CommentAnchor>;
  fromFiles: ReadonlyArray<VersionPatchFile>;
  paths?: ReadonlyArray<string>;
  toFiles: ReadonlyArray<VersionPatchFile>;
}) => {
  if (paths?.length) {
    return [...new Set(paths)];
  }
  return [
    ...new Set([
      ...fromFiles.map(pathKey),
      ...toFiles.map(pathKey),
      ...comments.map((comment) => comment.filePath),
    ]),
  ].toSorted((a, b) => a.localeCompare(b));
};

/**
 * Materialize left/right trees for jj-style rebase-then-diff.
 * left = headA when bases match, else apply(from-patch, onto baseB).
 * right = headB tree for the same path set.
 */
export const materializeRebaseReplayTrees = async ({
  from,
  fromFiles,
  paths,
  readBlob,
  to,
  toFiles,
}: {
  from: MergeRequestVersionRef;
  fromFiles: ReadonlyArray<VersionPatchFile>;
  paths?: ReadonlyArray<string>;
  readBlob: BlobLookup;
  to: MergeRequestVersionRef;
  toFiles: ReadonlyArray<VersionPatchFile>;
}): Promise<{
  fromTree: Map<string, string>;
  incompletePaths: Array<string>;
  toTree: Map<string, string>;
  warnings: Array<string>;
}> => {
  const targetPaths = collectVersionComparePaths({ fromFiles, paths, toFiles });
  const fromByPath = new Map(fromFiles.map((file) => [pathKey(file), file]));
  const toByPath = new Map(toFiles.map((file) => [pathKey(file), file]));
  const fromTree = new Map<string, string>();
  const toTree = new Map<string, string>();
  const incompletePaths: Array<string> = [];
  const warnings: Array<string> = [];
  const basesMatch = from.baseSha === to.baseSha;

  await poolMap(targetPaths, 8, async (path) => {
    const fromFile = fromByPath.get(path);
    const toFile = toByPath.get(path);
    try {
      const rightBlob = await readBlob(path, to.headSha);
      if (rightBlob != null) {
        toTree.set(path, rightBlob);
      } else if (toFile?.status === 'deleted') {
        // deleted in to → absent from right tree
      } else if (toFile) {
        // Reconstruct right from baseB + to-patch when head blob missing.
        const toBaseBlob = (await readBlob(path, to.baseSha)) ?? '';
        if (toFile.status === 'added' && !toBaseBlob) {
          const applied = applyUnifiedPatchBody('', toFile.patchBody);
          if (applied.conflict) {
            incompletePaths.push(path);
            warnings.push(`Conflict reconstructing ${path} at head ${to.headSha.slice(0, 7)}.`);
            return;
          }
          toTree.set(path, applied.text);
        } else if (toBaseBlob || toFile.patchBody) {
          const applied = applyUnifiedPatchBody(toBaseBlob, toFile.patchBody);
          if (applied.conflict) {
            incompletePaths.push(path);
            warnings.push(`Conflict reconstructing ${path} at head ${to.headSha.slice(0, 7)}.`);
            return;
          }
          toTree.set(path, applied.text);
        } else {
          incompletePaths.push(path);
          return;
        }
      }

      if (basesMatch) {
        const leftBlob = await readBlob(path, from.headSha);
        if (leftBlob != null) {
          fromTree.set(path, leftBlob);
        } else if (fromFile?.status === 'deleted') {
          // absent
        } else if (fromFile) {
          const fromBaseBlob = (await readBlob(path, from.baseSha)) ?? '';
          const applied = applyUnifiedPatchBody(fromBaseBlob, fromFile.patchBody);
          if (applied.conflict) {
            incompletePaths.push(path);
            warnings.push(`Conflict replaying ${path} onto ${from.baseSha.slice(0, 7)}.`);
            return;
          }
          fromTree.set(path, applied.text);
        } else if (rightBlob != null) {
          // Path only in to; left equals shared base/head-from content if present.
          const shared = await readBlob(path, from.headSha);
          if (shared != null) {
            fromTree.set(path, shared);
          }
        }
      } else {
        // Rebase from-patch onto to.base.
        const onto = (await readBlob(path, to.baseSha)) ?? '';
        if (fromFile) {
          let replayOk = false;
          if (fromFile.status === 'added' && !onto) {
            const applied = applyUnifiedPatchBody('', fromFile.patchBody);
            if (!applied.conflict) {
              fromTree.set(path, applied.text);
              replayOk = true;
            }
          } else {
            const applied = applyUnifiedPatchBody(onto, fromFile.patchBody);
            if (!applied.conflict) {
              fromTree.set(path, applied.text);
              replayOk = true;
            }
          }
          if (!replayOk) {
            // Replay produced a conflict — the base changed in a way that
            // affects this file's patch. Fall back to the actual v11 head
            // blob. The resulting diff (head-A vs head-B) may include some
            // base-change noise alongside intentional changes, but is still
            // localized and far more useful than dropping the path.
            const headABlob = await readBlob(path, from.headSha);
            if (headABlob != null) {
              fromTree.set(path, headABlob);
              warnings.push(
                `Replay conflict for ${path} — comparing v${from.label} head directly (may include base changes).`,
              );
            } else {
              incompletePaths.push(path);
              warnings.push(`Conflict replaying ${path} onto ${to.baseSha.slice(0, 7)}.`);
            }
          }
        } else if (onto) {
          // Unchanged in from MR; left is just the new base content.
          fromTree.set(path, onto);
        }
      }
    } catch (error) {
      incompletePaths.push(path);
      warnings.push(
        `Missing blobs for ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return { fromTree, incompletePaths, toTree, warnings };
};

/**
 * Prefer jj rebase-replay when trees can be materialized; fall back per-file
 * to approximate patch-text comparison for incomplete paths only.
 */
export const computeVersionComparePreferringReplay = async ({
  comments = [],
  from,
  fromFiles,
  paths,
  readBlob,
  to,
  toFiles,
}: {
  comments?: ReadonlyArray<CommentAnchor>;
  from: MergeRequestVersionRef;
  fromFiles: ReadonlyArray<VersionPatchFile>;
  paths?: ReadonlyArray<string>;
  readBlob: BlobLookup;
  to: MergeRequestVersionRef;
  toFiles: ReadonlyArray<VersionPatchFile>;
}): Promise<MergeRequestVersionCompare> => {
  const targetPaths = collectVersionComparePaths({ comments, fromFiles, paths, toFiles });
  const materialization = await materializeRebaseReplayTrees({
    from,
    fromFiles,
    paths,
    readBlob,
    to,
    toFiles,
  });
  const replayableCount = targetPaths.length - materialization.incompletePaths.length;
  const canReplay =
    targetPaths.length === 0
      ? false
      : materialization.incompletePaths.length === 0 ||
        replayableCount >= Math.ceil(targetPaths.length / 2);

  if (canReplay && (materialization.fromTree.size > 0 || materialization.toTree.size > 0)) {
    const replay = computeRebaseReplayVersionCompare({
      comments,
      from,
      fromTree: materialization.fromTree,
      paths,
      to,
      toTree: materialization.toTree,
    });
    const incomplete = new Set([...materialization.incompletePaths, ...replay.incompleteDiffPaths]);
    if (incomplete.size === 0) {
      return {
        ...replay,
        ...(materialization.warnings.length
          ? { warnings: [...new Set([...(replay.warnings ?? []), ...materialization.warnings])] }
          : {}),
      };
    }
    // Fill gaps with approximate for incomplete paths only.
    const approx = computeApproximatePatchTextVersionCompare({
      comments,
      from,
      fromFiles: fromFiles.filter((file) => incomplete.has(pathKey(file))),
      paths: [...incomplete],
      to,
      toFiles: toFiles.filter((file) => incomplete.has(pathKey(file))),
    });
    const files = [...replay.files, ...approx.files].toSorted((a, b) =>
      a.path.localeCompare(b.path),
    );
    const commentAssociations = comments.flatMap((comment) => {
      const source = incomplete.has(comment.filePath) ? approx : replay;
      const association = source.commentAssociations.find(
        (candidate) => candidate.commentId === comment.commentId,
      );
      return association ? [association] : [];
    });
    return {
      algorithm: 'jj-rebase-replay',
      commentAssociations,
      files,
      range: {
        from,
        ...(paths?.length ? { paths } : {}),
        to,
      },
      summary: {
        ...getVersionCompareLineStats(files),
        baseMoved: from.baseSha !== to.baseSha,
        commentsAffected: commentAssociations.filter((item) => item.status !== 'still-valid')
          .length,
        conflictFiles: files.filter((file) => file.classes.includes('conflict-resolution')).length,
        empty: files.length === 0,
        filesChanged: files.length,
        intentionalFiles: files.filter((file) => file.classes.includes('intentional')).length,
        noiseFiles: 0,
      },
      warnings: [
        ...new Set([
          ...(replay.warnings ?? []),
          ...(approx.warnings ?? []),
          ...materialization.warnings,
          ...[...incomplete].map(
            (path) =>
              `Approximate version comparison for ${path} (could not replay onto new base).`,
          ),
        ]),
      ],
    };
  }

  const approx = computeApproximatePatchTextVersionCompare({
    comments,
    from,
    fromFiles,
    paths,
    to,
    toFiles,
  });
  return {
    ...approx,
    warnings: [
      ...new Set([
        ...(approx.warnings ?? []),
        ...materialization.warnings,
        'Fell back to approximate patch-text version comparison (insufficient blobs for rebase-replay).',
      ]),
    ],
  };
};

export const isMergeRequestVersionRef = (value: unknown): value is MergeRequestVersionRef => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.baseSha === 'string' &&
    typeof value.startSha === 'string' &&
    typeof value.headSha === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.label === 'string'
  );
};

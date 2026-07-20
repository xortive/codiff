/**
 * Forge-neutral commit-stack evolution: patch signatures + stack matching.
 *
 * Used by GitLab MR versions and GitHub force-push head comparisons so both
 * forges share one pairing algorithm.
 */
import type {
  ChangedFile,
  ReviewCommitEvolution,
  ReviewCommitSummary,
  ReviewEvolutionUnit,
} from '../types.ts';
import { sha256 } from './crypto.ts';

export const versionCommitSignatureAlgorithmVersion = 'patch-signature-v1';
export const versionCommitEvolutionAlgorithmVersion = 'monotonic-v1';
export const versionCommitStackLimit = 40;
export const versionCommitDiffConcurrency = 4;

export type VersionCommitMatchKind =
  | 'retained'
  | 'rewritten-same-patch'
  | 'likely-revised'
  | 'absorbed-into-base'
  | 'added'
  | 'removed'
  | 'ambiguous';

export type VersionCommitSummary = {
  authoredAt: string;
  authorName: string;
  diffStat?: {
    additions: number;
    deletions: number;
    filesChanged: number;
  };
  parentIds: ReadonlyArray<string>;
  sha: string;
  shortSha: string;
  subject: string;
  webUrl: string;
};

export type CommitPatchSignature = {
  additions: number;
  changedPaths: ReadonlyArray<string>;
  changeTokenSketch: ReadonlyArray<string>;
  commitSha: string;
  deletions: number;
  exactPatchId: string;
  filesChanged: number;
  subjectKey: string;
};

export type VersionRebaseDriverCommit = {
  authoredAt: string;
  authorName: string;
  /** Paths this base commit shares with the revised MR commit interdiff. */
  overlappingPaths: ReadonlyArray<string>;
  sha: string;
  shortSha: string;
  subject: string;
  webUrl: string;
};

export type VersionCommitEvolutionUnit = {
  after?: VersionCommitSummary;
  baseCommit?: VersionCommitSummary;
  before?: VersionCommitSummary;
  confidence: 'exact' | 'high' | 'unmatched';
  id: string;
  kind: VersionCommitMatchKind;
  matchReasons?: ReadonlyArray<string>;
  matchScore?: number;
  order: number;
  /**
   * Base-branch commits that likely forced this commit rewrite during rebase.
   * Present only for revised units when base movement can be attributed.
   */
  rebaseDrivers?: ReadonlyArray<VersionRebaseDriverCommit>;
  reviewable: boolean;
};

/** Minimal endpoint identity needed for evolution range bookkeeping. */
export type DiffEndpointRef = {
  baseSha: string;
  createdAt?: string;
  headSha: string;
  id?: string;
  label?: string;
  startSha?: string;
};

export type CommitStackEvolutionRange = {
  from: DiffEndpointRef;
  paths?: ReadonlyArray<string>;
  to: DiffEndpointRef;
};

export type CommitStackEvolution = {
  range: CommitStackEvolutionRange;
  recommendation: {
    reason: string;
    structure: 'commit-by-commit' | 'whole-diff';
  };
  summary: {
    absorbedIntoBase: number;
    added: number;
    ambiguous: number;
    pairingCoverage: number;
    removed: number;
    retained: number;
    reviewable: number;
    revised: number;
    rewrittenSamePatch: number;
  };
  units: ReadonlyArray<VersionCommitEvolutionUnit>;
  warnings?: ReadonlyArray<string>;
};

/** @deprecated Prefer CommitStackEvolution. */
export type MergeRequestVersionCommitEvolution = CommitStackEvolution;

type CommitLike = {
  authoredDate: string;
  authorName: string;
  message: string;
  parentIds: ReadonlyArray<string>;
  sha: string;
  shortSha: string;
  title: string;
  webUrl: string;
};

const normalizedSubject = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/^(?:fixup!|squash!|amend!)\s*/g, '')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();

const lineCount = (files: ReadonlyArray<ChangedFile>) => {
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
  return { additions, deletions };
};

const normalizePatch = (files: ReadonlyArray<ChangedFile>) =>
  files
    .map((file) => {
      const changedLines = file.sections
        .flatMap((section) => section.patch.split('\n'))
        .filter(
          (line) =>
            (line.startsWith('+') || line.startsWith('-')) &&
            !line.startsWith('+++') &&
            !line.startsWith('---'),
        )
        .map((line) => `${line[0]}${line.slice(1).trim().replaceAll(/\s+/g, ' ')}`);
      return [file.oldPath ?? file.path, file.path, file.status, ...changedLines].join('\n');
    })
    .toSorted()
    .join('\n--file--\n');

const sketchHash = (value: string) => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const createCommitPatchSignature = async (
  commit: Pick<CommitLike, 'sha' | 'title'>,
  files: ReadonlyArray<ChangedFile>,
): Promise<CommitPatchSignature> => {
  const { additions, deletions } = lineCount(files);
  const tokens = files
    .flatMap((file) => file.sections)
    .flatMap((section) => section.patch.split('\n'))
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++') &&
        !line.startsWith('---'),
    )
    .flatMap(
      (line) =>
        line
          .slice(1)
          .toLowerCase()
          .match(/[a-z_][a-z0-9_]*|\d+|[^\s\w]/g) ?? [],
    )
    .map(sketchHash);
  return {
    additions,
    changedPaths: [
      ...new Set(files.flatMap((file) => [file.oldPath, file.path]).filter(Boolean)),
    ].toSorted() as Array<string>,
    changeTokenSketch: [...new Set(tokens)].toSorted().slice(0, 128),
    commitSha: commit.sha,
    deletions,
    exactPatchId: await sha256(normalizePatch(files)),
    filesChanged: files.length,
    subjectKey: normalizedSubject(commit.title),
  };
};

export const toVersionCommitSummary = (
  commit: CommitLike,
  signature?: CommitPatchSignature,
): VersionCommitSummary =>
  ({
    authoredAt: commit.authoredDate,
    authorName: commit.authorName,
    ...(signature
      ? {
          diffStat: {
            additions: signature.additions,
            deletions: signature.deletions,
            filesChanged: signature.filesChanged,
          },
        }
      : {}),
    parentIds: commit.parentIds,
    sha: commit.sha,
    shortSha: commit.shortSha || commit.sha.slice(0, 8),
    subject: commit.title || commit.message.split('\n')[0] || 'Commit',
    webUrl: commit.webUrl,
  }) as VersionCommitSummary;

const jaccard = (first: ReadonlyArray<string>, second: ReadonlyArray<string>) => {
  const left = new Set(first);
  const right = new Set(second);
  const union = new Set([...left, ...right]);
  if (union.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  return intersection / union.size;
};

const sizeSimilarity = (first: CommitPatchSignature, second: CommitPatchSignature) => {
  const left = first.additions + first.deletions;
  const right = second.additions + second.deletions;
  return Math.max(left, right) === 0 ? 1 : Math.min(left, right) / Math.max(left, right);
};

const scoreCandidate = (
  oldCommit: CommitLike,
  newCommit: CommitLike,
  oldSignature: CommitPatchSignature,
  newSignature: CommitPatchSignature,
  oldPosition: number,
  newPosition: number,
  oldLength: number,
  newLength: number,
) => {
  const subject = jaccard(oldSignature.subjectKey.split(' '), newSignature.subjectKey.split(' '));
  const author = oldCommit.authorName.toLowerCase() === newCommit.authorName.toLowerCase() ? 1 : 0;
  const paths = jaccard(oldSignature.changedPaths, newSignature.changedPaths);
  const tokens = jaccard(oldSignature.changeTokenSketch, newSignature.changeTokenSketch);
  const size = sizeSimilarity(oldSignature, newSignature);
  const relativePosition =
    1 - Math.min(1, Math.abs(oldPosition / oldLength - newPosition / newLength));
  const score =
    subject * 0.22 +
    author * 0.08 +
    paths * 0.24 +
    tokens * 0.32 +
    size * 0.1 +
    relativePosition * 0.04;
  const reasons = [
    subject >= 0.7 ? 'similar subject' : null,
    author ? 'same author' : null,
    paths >= 0.6 ? 'overlapping paths' : null,
    tokens >= 0.6 ? 'similar changed lines' : null,
    size >= 0.7 ? 'similar patch size' : null,
  ].filter((reason): reason is string => reason != null);
  return { reasons, score };
};

const unitId = async (
  range: CommitStackEvolutionRange,
  kind: VersionCommitMatchKind,
  before?: string,
  after?: string,
) =>
  `vcu-${(
    await sha256(
      [
        range.from.baseSha,
        range.from.headSha,
        range.to.baseSha,
        range.to.headSha,
        kind,
        before,
        after,
      ].join(':'),
    )
  ).slice(0, 20)}`;

export const recommendVersionWalkthroughStructure = ({
  ambiguous,
  failedUnitDiffs = 0,
  pairingCoverage,
  reviewable,
  tinyUnits = 0,
}: {
  ambiguous: number;
  failedUnitDiffs?: number;
  pairingCoverage: number;
  reviewable: number;
  tinyUnits?: number;
}): CommitStackEvolution['recommendation'] => {
  if (reviewable <= 1) {
    return {
      reason: 'A whole diff is clearer for zero or one changed commit.',
      structure: 'whole-diff',
    };
  }
  if (failedUnitDiffs > 0) {
    return { reason: 'Some commit-unit diffs could not be materialized.', structure: 'whole-diff' };
  }
  if (pairingCoverage < 0.8) {
    return { reason: 'Commit pairing confidence is below 80%.', structure: 'whole-diff' };
  }
  if (ambiguous > Math.max(1, Math.floor(reviewable * 0.2))) {
    return { reason: 'Too many stack changes are ambiguous.', structure: 'whole-diff' };
  }
  if (tinyUnits > reviewable / 2) {
    return {
      reason: 'The stack is dominated by tiny mechanical changes.',
      structure: 'whole-diff',
    };
  }
  return {
    reason: `Review ${reviewable} changed commit units in stack order.`,
    structure: 'commit-by-commit',
  };
};

export const matchVersionCommitStacks = async ({
  baseCommits = [],
  baseStackComplete = true,
  from,
  newCommits,
  oldCommits,
  signatures,
  stackCompleteness = { new: true, old: true },
  to,
  warnings = [],
}: {
  baseCommits?: ReadonlyArray<CommitLike>;
  baseStackComplete?: boolean;
  from: DiffEndpointRef;
  newCommits: ReadonlyArray<CommitLike>;
  oldCommits: ReadonlyArray<CommitLike>;
  signatures: ReadonlyMap<string, CommitPatchSignature>;
  stackCompleteness?: { new: boolean; old: boolean };
  to: DiffEndpointRef;
  warnings?: ReadonlyArray<string>;
}): Promise<CommitStackEvolution> => {
  const range = { from, to };
  const matches: Array<{
    after?: CommitLike;
    baseCommit?: CommitLike;
    before?: CommitLike;
    confidence: VersionCommitEvolutionUnit['confidence'];
    kind: VersionCommitMatchKind;
    reasons?: ReadonlyArray<string>;
    score?: number;
  }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const usedBase = new Set<string>();
  const newBySha = new Map(newCommits.map((commit) => [commit.sha, commit]));

  for (const commit of oldCommits) {
    const after = newBySha.get(commit.sha);
    if (!after) {
      continue;
    }
    usedOld.add(commit.sha);
    usedNew.add(after.sha);
    matches.push({ after, before: commit, confidence: 'exact', kind: 'retained' });
  }

  const oldByPatch = new Map<string, Array<CommitLike>>();
  const newByPatch = new Map<string, Array<CommitLike>>();
  const ambiguousOld = new Set<string>();
  const ambiguousNew = new Set<string>();
  for (const commit of oldCommits.filter((entry) => !usedOld.has(entry.sha))) {
    const signature = signatures.get(commit.sha);
    if (signature) {
      oldByPatch.set(signature.exactPatchId, [
        ...(oldByPatch.get(signature.exactPatchId) ?? []),
        commit,
      ]);
    }
  }
  for (const commit of newCommits.filter((entry) => !usedNew.has(entry.sha))) {
    const signature = signatures.get(commit.sha);
    if (signature) {
      newByPatch.set(signature.exactPatchId, [
        ...(newByPatch.get(signature.exactPatchId) ?? []),
        commit,
      ]);
    }
  }
  for (const [patchId, oldMatches] of oldByPatch) {
    const newMatches = newByPatch.get(patchId) ?? [];
    if (newMatches.length > 0 && (oldMatches.length > 1 || newMatches.length > 1)) {
      oldMatches.forEach((commit) => ambiguousOld.add(commit.sha));
      newMatches.forEach((commit) => ambiguousNew.add(commit.sha));
      continue;
    }
    if (oldMatches.length !== 1 || newMatches.length !== 1) {
      continue;
    }
    const before = oldMatches[0]!;
    const after = newMatches[0]!;
    usedOld.add(before.sha);
    usedNew.add(after.sha);
    matches.push({ after, before, confidence: 'exact', kind: 'rewritten-same-patch' });
  }

  const exactAnchors = matches
    .filter((match) => match.before && match.after)
    .map((match) => ({
      newIndex: newCommits.findIndex((commit) => commit.sha === match.after!.sha),
      oldIndex: oldCommits.findIndex((commit) => commit.sha === match.before!.sha),
    }));
  const respectsExactAnchors = (oldIndex: number, newIndex: number) =>
    exactAnchors.every(
      (anchor) =>
        (oldIndex < anchor.oldIndex && newIndex < anchor.newIndex) ||
        (oldIndex > anchor.oldIndex && newIndex > anchor.newIndex),
    );

  let lastNewIndex = -1;
  for (let oldIndex = 0; oldIndex < oldCommits.length; oldIndex += 1) {
    const before = oldCommits[oldIndex]!;
    if (usedOld.has(before.sha) || ambiguousOld.has(before.sha)) {
      continue;
    }
    const oldSignature = signatures.get(before.sha);
    if (!oldSignature || before.parentIds.length > 1) {
      continue;
    }
    const candidates = newCommits
      .map((after, newIndex) => ({ after, newIndex }))
      .filter(
        ({ after, newIndex }) =>
          !usedNew.has(after.sha) &&
          !ambiguousNew.has(after.sha) &&
          newIndex > lastNewIndex &&
          respectsExactAnchors(oldIndex, newIndex) &&
          after.parentIds.length <= 1,
      )
      .map(({ after, newIndex }) => {
        const signature = signatures.get(after.sha);
        return signature
          ? {
              after,
              newIndex,
              ...scoreCandidate(
                before,
                after,
                oldSignature,
                signature,
                oldIndex,
                newIndex,
                Math.max(1, oldCommits.length - 1),
                Math.max(1, newCommits.length - 1),
              ),
            }
          : null;
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate != null)
      .toSorted((first, second) => second.score - first.score);
    const best = candidates[0];
    const runnerUp = candidates[1];
    if (!best || best.score < 0.72 || (runnerUp && best.score - runnerUp.score < 0.12)) {
      if (best && best.score >= 0.55) {
        ambiguousOld.add(before.sha);
        ambiguousNew.add(best.after.sha);
      }
      continue;
    }
    usedOld.add(before.sha);
    usedNew.add(best.after.sha);
    lastNewIndex = best.newIndex;
    matches.push({
      after: best.after,
      before,
      confidence: 'high',
      kind: 'likely-revised',
      reasons: best.reasons,
      score: Number(best.score.toFixed(3)),
    });
  }

  const unmatchedOld = () => oldCommits.filter((commit) => !usedOld.has(commit.sha));
  const baseBySha = new Map(baseCommits.map((commit) => [commit.sha, commit]));
  for (const before of unmatchedOld()) {
    const baseCommit = baseBySha.get(before.sha);
    if (!baseCommit || usedBase.has(baseCommit.sha)) {
      continue;
    }
    usedOld.add(before.sha);
    usedBase.add(baseCommit.sha);
    matches.push({
      baseCommit,
      before,
      confidence: 'exact',
      kind: 'absorbed-into-base',
      reasons: ['Commit is now present in the later target base'],
    });
  }

  const baseByPatch = new Map<string, Array<CommitLike>>();
  for (const commit of baseCommits.filter((entry) => !usedBase.has(entry.sha))) {
    const signature = signatures.get(commit.sha);
    if (signature) {
      baseByPatch.set(signature.exactPatchId, [
        ...(baseByPatch.get(signature.exactPatchId) ?? []),
        commit,
      ]);
    }
  }
  for (const before of unmatchedOld()) {
    const signature = signatures.get(before.sha);
    if (!signature) {
      continue;
    }
    const candidates = baseByPatch
      .get(signature.exactPatchId)
      ?.filter((commit) => !usedBase.has(commit.sha));
    if (candidates?.length !== 1) {
      continue;
    }
    const baseCommit = candidates[0]!;
    usedOld.add(before.sha);
    usedBase.add(baseCommit.sha);
    matches.push({
      baseCommit,
      before,
      confidence: 'exact',
      kind: 'absorbed-into-base',
      reasons: ['Equivalent patch is now present in the later target base'],
    });
  }

  for (let oldIndex = 0; oldIndex < oldCommits.length; oldIndex += 1) {
    const before = oldCommits[oldIndex]!;
    if (usedOld.has(before.sha) || ambiguousOld.has(before.sha)) {
      continue;
    }
    const oldSignature = signatures.get(before.sha);
    if (!oldSignature || before.parentIds.length > 1) {
      continue;
    }
    const candidates = baseCommits
      .map((baseCommit, baseIndex) => ({ baseCommit, baseIndex }))
      .filter(({ baseCommit }) => !usedBase.has(baseCommit.sha) && baseCommit.parentIds.length <= 1)
      .map(({ baseCommit, baseIndex }) => {
        const signature = signatures.get(baseCommit.sha);
        return signature
          ? {
              baseCommit,
              ...scoreCandidate(
                before,
                baseCommit,
                oldSignature,
                signature,
                oldIndex,
                baseIndex,
                Math.max(1, oldCommits.length - 1),
                Math.max(1, baseCommits.length - 1),
              ),
            }
          : null;
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate != null)
      .toSorted((first, second) => second.score - first.score);
    const best = candidates[0];
    const runnerUp = candidates[1];
    if (!best || best.score < 0.72 || (runnerUp && best.score - runnerUp.score < 0.12)) {
      continue;
    }
    usedOld.add(before.sha);
    usedBase.add(best.baseCommit.sha);
    matches.push({
      baseCommit: best.baseCommit,
      before,
      confidence: 'high',
      kind: 'absorbed-into-base',
      reasons: [...best.reasons, 'Logical commit is now present in the later target base'],
      score: Number(best.score.toFixed(3)),
    });
  }

  const canClassifyUnpaired = stackCompleteness.old && stackCompleteness.new;
  const canClassifyRemoved = canClassifyUnpaired && baseStackComplete;
  for (const commit of oldCommits) {
    if (!usedOld.has(commit.sha)) {
      const classificationIsIncomplete =
        !canClassifyRemoved || !signatures.has(commit.sha) || ambiguousOld.has(commit.sha);
      matches.push({
        before: commit,
        confidence: 'unmatched',
        kind: classificationIsIncomplete ? 'ambiguous' : 'removed',
        ...(classificationIsIncomplete
          ? {
              reasons: ['Insufficient evidence to classify this commit as removed'],
            }
          : {}),
      });
    }
  }
  for (const commit of newCommits) {
    if (!usedNew.has(commit.sha)) {
      const classificationIsIncomplete =
        !canClassifyUnpaired || !signatures.has(commit.sha) || ambiguousNew.has(commit.sha);
      matches.push({
        after: commit,
        confidence: 'unmatched',
        kind: classificationIsIncomplete ? 'ambiguous' : 'added',
        ...(classificationIsIncomplete
          ? {
              reasons: ['Insufficient evidence to classify this commit as new'],
            }
          : {}),
      });
    }
  }

  const oldOrder = new Map(oldCommits.map((commit, index) => [commit.sha, index]));
  const newOrder = new Map(newCommits.map((commit, index) => [commit.sha, index]));
  const units = await Promise.all(
    matches.map(async (match) => {
      const beforeSignature = match.before ? signatures.get(match.before.sha) : undefined;
      const afterSignature = match.after ? signatures.get(match.after.sha) : undefined;
      const baseSignature = match.baseCommit ? signatures.get(match.baseCommit.sha) : undefined;
      const oldIndex = match.before
        ? (oldOrder.get(match.before.sha) ?? oldCommits.length)
        : oldCommits.length;
      const nextMatched = match.baseCommit
        ? matches
            .filter(
              (candidate) =>
                candidate.before &&
                candidate.after &&
                (oldOrder.get(candidate.before.sha) ?? oldCommits.length) > oldIndex,
            )
            .toSorted(
              (first, second) =>
                (oldOrder.get(first.before!.sha) ?? oldCommits.length) -
                (oldOrder.get(second.before!.sha) ?? oldCommits.length),
            )[0]
        : undefined;
      const order = match.after
        ? (newOrder.get(match.after.sha) ?? newCommits.length)
        : match.baseCommit && nextMatched?.after
          ? (newOrder.get(nextMatched.after.sha) ?? 0) -
            (oldOrder.get(nextMatched.before!.sha)! - oldIndex) / (oldCommits.length + 1)
          : newCommits.length + oldIndex / (oldCommits.length + 1);
      return {
        ...(match.after ? { after: toVersionCommitSummary(match.after, afterSignature) } : {}),
        ...(match.baseCommit
          ? { baseCommit: toVersionCommitSummary(match.baseCommit, baseSignature) }
          : {}),
        ...(match.before ? { before: toVersionCommitSummary(match.before, beforeSignature) } : {}),
        confidence: match.confidence,
        id: await unitId(
          range,
          match.kind,
          match.before?.sha,
          match.after?.sha ?? match.baseCommit?.sha,
        ),
        kind: match.kind,
        ...(match.reasons ? { matchReasons: match.reasons } : {}),
        ...(match.score != null ? { matchScore: match.score } : {}),
        order,
        reviewable:
          (match.kind === 'likely-revised' || match.kind === 'added' || match.kind === 'removed') &&
          (match.before?.parentIds.length ?? 0) <= 1 &&
          (match.after?.parentIds.length ?? 0) <= 1,
      } satisfies VersionCommitEvolutionUnit;
    }),
  );
  units.sort((first, second) => first.order - second.order || first.id.localeCompare(second.id));
  const count = (kind: VersionCommitMatchKind) => units.filter((unit) => unit.kind === kind).length;
  const revised = count('likely-revised');
  const absorbedIntoBase = count('absorbed-into-base');
  const removed = count('removed');
  const added = count('added');
  const ambiguous = count('ambiguous');
  const pairingDenominator = revised + Math.min(removed, added);
  const pairingCoverage = pairingDenominator === 0 ? 1 : revised / pairingDenominator;
  const reviewable = units.filter((unit) => unit.reviewable).length;
  return {
    range,
    recommendation: recommendVersionWalkthroughStructure({
      ambiguous,
      pairingCoverage,
      reviewable,
    }),
    summary: {
      absorbedIntoBase,
      added,
      ambiguous,
      pairingCoverage,
      removed,
      retained: count('retained'),
      reviewable,
      revised,
      rewrittenSamePatch: count('rewritten-same-patch'),
    },
    units,
    ...(warnings.length ? { warnings } : {}),
  };
};

const pathTokens = (paths: ReadonlyArray<string>) =>
  paths
    .flatMap((path) => path.toLowerCase().split(/[^a-z0-9]+/g))
    .filter((token) => token.length > 2);

export const scoreBaseCommitAsRebaseDriver = ({
  baseSignature,
  unitSignature,
}: {
  baseSignature: Pick<
    CommitPatchSignature,
    'changedPaths' | 'changeTokenSketch' | 'additions' | 'deletions'
  >;
  unitSignature: Pick<
    CommitPatchSignature,
    'changedPaths' | 'changeTokenSketch' | 'additions' | 'deletions'
  >;
}) => {
  const overlappingPaths = unitSignature.changedPaths.filter((path) =>
    baseSignature.changedPaths.includes(path),
  );
  const pathOverlap =
    unitSignature.changedPaths.length === 0
      ? 0
      : overlappingPaths.length / unitSignature.changedPaths.length;
  const tokens = jaccard(unitSignature.changeTokenSketch, baseSignature.changeTokenSketch);
  const pathNameTokens = jaccard(
    pathTokens(unitSignature.changedPaths),
    pathTokens(baseSignature.changedPaths),
  );
  const left = unitSignature.additions + unitSignature.deletions;
  const right = baseSignature.additions + baseSignature.deletions;
  const size = Math.max(left, right) === 0 ? 1 : Math.min(left, right) / Math.max(left, right);
  // Prefer path overlap heavily: a base commit that touches the same files is the
  // strongest signal that the MR commit was revised due to rebase conflict fallout.
  const score = pathOverlap * 0.62 + tokens * 0.28 + pathNameTokens * 0.06 + size * 0.04;
  return {
    overlappingPaths,
    score: Number(score.toFixed(3)),
  };
};

export const attributeRebaseDrivers = ({
  baseCommits,
  baseSignatures,
  limit = 3,
  unitSignature,
}: {
  baseCommits: ReadonlyArray<{
    authoredAt: string;
    authorName: string;
    sha: string;
    shortSha: string;
    subject: string;
    webUrl: string;
  }>;
  baseSignatures: ReadonlyMap<string, CommitPatchSignature>;
  limit?: number;
  unitSignature: CommitPatchSignature | null | undefined;
}): Array<VersionRebaseDriverCommit> => {
  if (!unitSignature || unitSignature.changedPaths.length === 0 || baseCommits.length === 0) {
    return [];
  }
  return baseCommits
    .map((commit) => {
      const signature = baseSignatures.get(commit.sha);
      if (!signature) {
        return null;
      }
      const { overlappingPaths, score } = scoreBaseCommitAsRebaseDriver({
        baseSignature: signature,
        unitSignature,
      });
      if (score < 0.22 || overlappingPaths.length === 0) {
        return null;
      }
      return {
        authoredAt: commit.authoredAt,
        authorName: commit.authorName,
        overlappingPaths,
        score,
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        webUrl: commit.webUrl,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry != null)
    .toSorted((first, second) => second.score - first.score || first.sha.localeCompare(second.sha))
    .slice(0, limit)
    .map(({ score: _score, ...commit }) => commit);
};

type ProjectableCommit = {
  authoredAt: string;
  authorName: string;
  diffStat?: { additions: number; deletions: number; filesChanged: number };
  parentIds?: ReadonlyArray<string>;
  sha: string;
  shortSha: string;
  subject: string;
  webUrl?: string;
};

const projectCommitSummary = (
  commit: ProjectableCommit | undefined,
): ReviewCommitSummary | undefined => {
  if (!commit) {
    return undefined;
  }
  return {
    authoredAt: commit.authoredAt,
    authorName: commit.authorName,
    parentIds: commit.parentIds ?? [],
    sha: commit.sha,
    shortSha: commit.shortSha,
    subject: commit.subject,
    webUrl: commit.webUrl,
    ...(commit.diffStat ? { diffStat: commit.diffStat } : {}),
  };
};

/**
 * Project forge-internal evolution units onto Core {@link ReviewEvolutionUnit}.
 * Maps GitLab-ish kinds (`added` / `likely-revised`) onto host UI kinds
 * (`introduced` / `revised`).
 */
export const projectEvolutionUnit = (unit: {
  after?: ProjectableCommit;
  baseCommit?: ProjectableCommit;
  before?: ProjectableCommit;
  confidence: 'exact' | 'high' | 'unmatched';
  id: string;
  kind: string;
  matchReasons?: ReadonlyArray<string>;
  matchScore?: number;
  order: number;
  rebaseDrivers?: ReadonlyArray<{
    authoredAt: string;
    authorName: string;
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
              authoredAt: driver.authoredAt,
              authorName: driver.authorName,
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
      ...(projectCommitSummary(unit.baseCommit)
        ? { baseCommit: projectCommitSummary(unit.baseCommit) }
        : {}),
      ...(projectCommitSummary(unit.before) ? { before: projectCommitSummary(unit.before) } : {}),
    };
  }
  return {
    ...common,
    kind: unit.kind === 'rewritten-same-patch' ? 'rewritten-same-patch' : 'retained',
    reviewable: false,
    ...(projectCommitSummary(unit.after) ? { after: projectCommitSummary(unit.after) } : {}),
    ...(projectCommitSummary(unit.before) ? { before: projectCommitSummary(unit.before) } : {}),
  };
};

/** Project forge-internal stack evolution onto Core {@link ReviewCommitEvolution}. */
export const projectCommitEvolution = (evolution: CommitStackEvolution): ReviewCommitEvolution => ({
  recommendation: {
    rationale: evolution.recommendation.reason,
    suggestedStructure: evolution.recommendation.structure,
  },
  summary: evolution.summary,
  units: evolution.units.map(projectEvolutionUnit),
  ...(evolution.warnings ? { warnings: evolution.warnings } : {}),
});

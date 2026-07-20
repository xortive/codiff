/**
 * Re-export forge-neutral commit-stack evolution from Core.
 * Kept as a stable GitLab package path for existing imports.
 */
export {
  attributeRebaseDrivers,
  createCommitPatchSignature,
  matchVersionCommitStacks,
  recommendVersionWalkthroughStructure,
  scoreBaseCommitAsRebaseDriver,
  toVersionCommitSummary,
  versionCommitDiffConcurrency,
  versionCommitEvolutionAlgorithmVersion,
  versionCommitSignatureAlgorithmVersion,
  versionCommitStackLimit,
  type CommitPatchSignature,
  type CommitStackEvolution,
  type CommitStackEvolutionRange,
  type DiffEndpointRef,
  type VersionCommitEvolutionUnit,
  type VersionCommitMatchKind,
  type VersionCommitSummary,
  type VersionRebaseDriverCommit,
} from '@nkzw/codiff-core';

import type { CommitStackEvolution } from '@nkzw/codiff-core';

/** @deprecated Prefer CommitStackEvolution. */
export type MergeRequestVersionCommitEvolution = CommitStackEvolution;

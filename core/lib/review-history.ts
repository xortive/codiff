import type {
  DiffComparison,
  DiffComparisonAnalysis,
  DiffComparisonView,
  DiffRange,
  ReviewCommitEvolution,
  ReviewEvolutionUnit,
  ReviewPlan,
  ReviewStructureRecommendation,
  ReviewUnit,
  ReviewVersionOption,
  RevisionLabel,
  RevisionRef,
} from '../types.ts';

/** Create a commit-scoped revision label. */
export const commitRevisionLabel = (text: string, url?: string): RevisionLabel => ({
  kind: 'commit',
  text,
  ...(url ? { url } : {}),
});

/** Create a version-scoped revision label. */
export const versionRevisionLabel = (text: string, url?: string): RevisionLabel => ({
  kind: 'version',
  text,
  ...(url ? { url } : {}),
});

export const revisionRef = (
  commitId: string,
  label: RevisionLabel,
  aliases?: ReadonlyArray<RevisionLabel>,
): RevisionRef => ({
  commitId,
  label,
  ...(aliases?.length ? { aliases } : {}),
});

export const diffRange = (base: RevisionRef, head: RevisionRef): DiffRange => ({ base, head });

export const diffComparison = (before: DiffRange, after: DiffRange): DiffComparison => ({
  after,
  before,
});

export const reviewVersionOption = ({
  createdAt,
  diffStat,
  id,
  isHead,
  number,
  previousCreatedAt,
  previousNumber,
  range,
}: {
  createdAt: string;
  diffStat?: ReviewVersionOption['diffStat'];
  id: string;
  isHead?: boolean;
  number?: number;
  previousCreatedAt?: string;
  previousNumber?: number;
  range: DiffRange;
}): ReviewVersionOption => ({
  createdAt,
  id,
  range,
  ...(diffStat ? { diffStat } : {}),
  ...(isHead != null ? { isHead } : {}),
  ...(number != null ? { number } : {}),
  ...(previousCreatedAt ? { previousCreatedAt } : {}),
  ...(previousNumber != null ? { previousNumber } : {}),
});

export const isReviewableUnit = (unit: ReviewEvolutionUnit): unit is ReviewUnit =>
  unit.reviewable === true;

export const reviewableUnits = (
  units: ReadonlyArray<ReviewEvolutionUnit>,
): ReadonlyArray<ReviewUnit> => units.filter(isReviewableUnit);

export const resolveReviewPlan = ({
  analysis,
  comparison,
  recommendation,
  structure,
  units,
}: {
  analysis?: DiffComparisonAnalysis;
  comparison?: DiffComparison;
  recommendation?: ReviewStructureRecommendation;
  structure?: 'commit-by-commit' | 'units' | 'whole-diff' | 'auto';
  units?: ReadonlyArray<ReviewEvolutionUnit>;
}): ReviewPlan => {
  const reviewUnits = units ? reviewableUnits(units) : [];
  const resolved =
    structure === 'whole-diff'
      ? 'whole-diff'
      : structure === 'commit-by-commit' || structure === 'units'
        ? 'units'
        : recommendation?.suggestedStructure === 'commit-by-commit' && reviewUnits.length > 0
          ? 'units'
          : 'whole-diff';

  if (resolved === 'units' && reviewUnits.length > 0) {
    return {
      structure: 'units',
      units: reviewUnits,
      ...(analysis ? { analysis } : {}),
      ...(comparison ? { comparison } : {}),
    };
  }

  return {
    structure: 'whole-diff',
    ...(analysis ? { analysis } : {}),
    ...(comparison ? { comparison } : {}),
  };
};

export const diffComparisonView = ({
  analysis,
  comparison,
  files,
  from,
  to,
}: {
  analysis: DiffComparisonAnalysis;
  comparison: DiffComparison;
  files: DiffComparisonView['files'];
  from: ReviewVersionOption;
  to: ReviewVersionOption;
}): DiffComparisonView => ({
  analysis,
  comparison,
  files,
  from,
  to,
});

export const reviewCommitEvolution = (evolution: ReviewCommitEvolution): ReviewCommitEvolution =>
  evolution;

export const versionOptionHeadCommitId = (version: ReviewVersionOption) =>
  version.range.head.commitId;

export const versionOptionBaseCommitId = (version: ReviewVersionOption) =>
  version.range.base.commitId;

export const versionOptionLabelText = (version: ReviewVersionOption) =>
  version.number != null
    ? version.number === 0
      ? 'Base'
      : `v${version.number}`
    : version.range.head.label.text;

export const evolutionUnitCommit = (unit: ReviewEvolutionUnit) => {
  if (unit.kind === 'commit') {
    return unit.commit;
  }
  if (unit.kind === 'introduced') {
    return unit.after;
  }
  if (unit.kind === 'removed') {
    return unit.before;
  }
  if (unit.kind === 'revised') {
    return unit.after ?? unit.before;
  }
  if (unit.kind === 'ambiguous') {
    return unit.after ?? unit.before;
  }
  if (unit.kind === 'absorbed-into-base') {
    return unit.baseCommit ?? unit.before ?? unit.after;
  }
  return unit.after ?? unit.before;
};

export const evolutionUnitRebaseDrivers = (unit: ReviewEvolutionUnit) =>
  unit.kind === 'revised' ? (unit.rebaseDrivers ?? []) : [];

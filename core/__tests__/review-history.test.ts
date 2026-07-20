import { expect, test } from 'vite-plus/test';
import {
  commitRevisionLabel,
  diffComparison,
  diffRange,
  resolveReviewPlan,
  reviewableUnits,
  revisionRef,
  reviewVersionOption,
  versionOptionHeadCommitId,
  versionRevisionLabel,
} from '../lib/review-history.ts';
import type { ReviewEvolutionUnit } from '../types.ts';

const base = revisionRef('a'.repeat(40), commitRevisionLabel('base'));
const headOld = revisionRef('b'.repeat(40), versionRevisionLabel('v1'));
const headNew = revisionRef('c'.repeat(40), versionRevisionLabel('v2'));

const before = diffRange(base, headOld);
const after = diffRange(base, headNew);
const comparison = diffComparison(before, after);

const units: ReadonlyArray<ReviewEvolutionUnit> = [
  {
    after: {
      authoredAt: '2026-01-01T00:00:00.000Z',
      authorName: 'A',
      parentIds: [base.commitId],
      sha: headNew.commitId,
      shortSha: headNew.commitId.slice(0, 7),
      subject: 'feat: add',
    },
    confidence: 'high',
    id: 'introduced-1',
    kind: 'introduced',
    order: 0,
    reviewable: true,
  },
  {
    after: {
      authoredAt: '2026-01-01T00:00:00.000Z',
      authorName: 'A',
      parentIds: [base.commitId],
      sha: headOld.commitId,
      shortSha: headOld.commitId.slice(0, 7),
      subject: 'same',
    },
    before: {
      authoredAt: '2026-01-01T00:00:00.000Z',
      authorName: 'A',
      parentIds: [base.commitId],
      sha: headOld.commitId,
      shortSha: headOld.commitId.slice(0, 7),
      subject: 'same',
    },
    confidence: 'exact',
    id: 'retained-1',
    kind: 'retained',
    order: 1,
    reviewable: false,
  },
];

test('projects version options through DiffRange identity', () => {
  const version = reviewVersionOption({
    createdAt: '2026-01-02T00:00:00.000Z',
    id: '2',
    number: 2,
    range: after,
  });
  expect(versionOptionHeadCommitId(version)).toBe(headNew.commitId);
  expect(version.range.base.commitId).toBe(base.commitId);
});

test('filters non-reviewable evolution markers from unit plans', () => {
  expect(reviewableUnits(units).map((unit) => unit.kind)).toEqual(['introduced']);
});

test('resolves whole-diff and unit plans from recommendations', () => {
  expect(
    resolveReviewPlan({
      comparison,
      recommendation: {
        rationale: 'Low pairing confidence.',
        suggestedStructure: 'whole-diff',
      },
      units,
    }),
  ).toMatchObject({ structure: 'whole-diff' });

  expect(
    resolveReviewPlan({
      comparison,
      recommendation: {
        rationale: 'Review introduced units.',
        suggestedStructure: 'commit-by-commit',
      },
      structure: 'auto',
      units,
    }),
  ).toMatchObject({
    structure: 'units',
    units: [{ kind: 'introduced' }],
  });

  expect(
    resolveReviewPlan({
      comparison,
      structure: 'whole-diff',
      units,
    }),
  ).toMatchObject({ structure: 'whole-diff' });
});

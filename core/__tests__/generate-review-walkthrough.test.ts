import { expect, test, vi } from 'vite-plus/test';
import { generateReviewWalkthrough } from '../lib/generate-review-walkthrough.ts';
import type { RepositoryState, ReviewCommitEvolution } from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';

const baseState = {
  branch: 'feature',
  files: [createChangedFile('src/app.ts')],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: {
    number: 1,
    provider: 'github',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/1',
  },
} satisfies RepositoryState;

const draft = {
  chapters: [
    {
      blurb: 'Review the change.',
      icon: 'gear',
      id: 'c1',
      stops: [
        {
          hunkIds: ['h1'],
          id: 's1',
          importance: 'critical',
          prose: 'Check this.',
          title: 'Main change',
        },
      ],
      title: 'Core',
    },
  ],
  focus: 'Focus',
  kind: 'narrative',
  title: 'Walkthrough',
  version: 4,
};

test('generateReviewWalkthrough whole-diff path prompts once and normalizes', async () => {
  const runModel = vi.fn(async () => ({ draft }));
  const result = await generateReviewWalkthrough({
    agent: 'codex',
    runModel,
    states: { whole: baseState },
    structure: 'whole-diff',
  });
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') {
    return;
  }
  expect(runModel).toHaveBeenCalledTimes(1);
  expect(result.walkthrough.kind).toBe('narrative');
  expect(result.plan.structure).toBe('whole-diff');
});

test('generateReviewWalkthrough units path fans out and composes', async () => {
  const evolution = {
    recommendation: {
      rationale: 'Multiple units changed.',
      suggestedStructure: 'commit-by-commit',
    },
    summary: {
      absorbedIntoBase: 0,
      added: 2,
      ambiguous: 0,
      pairingCoverage: 0,
      removed: 0,
      retained: 0,
      reviewable: 2,
      revised: 0,
      rewrittenSamePatch: 0,
    },
    units: [
      {
        after: {
          authoredAt: '2026-01-01T00:00:00.000Z',
          authorName: 'Ada',
          parentIds: [],
          sha: 'a'.repeat(40),
          shortSha: 'aaaaaaa',
          subject: 'one',
        },
        confidence: 'exact',
        id: 'introduced:a',
        kind: 'introduced',
        order: 0,
        reviewable: true,
      },
      {
        after: {
          authoredAt: '2026-01-01T01:00:00.000Z',
          authorName: 'Ada',
          parentIds: [],
          sha: 'b'.repeat(40),
          shortSha: 'bbbbbbb',
          subject: 'two',
        },
        confidence: 'exact',
        id: 'introduced:b',
        kind: 'introduced',
        order: 1,
        reviewable: true,
      },
    ],
  } satisfies ReviewCommitEvolution;

  const runModel = vi.fn(async () => ({ draft }));
  const unitState = {
    ...baseState,
    files: [createChangedFile('src/unit.ts')],
  } satisfies RepositoryState;

  const result = await generateReviewWalkthrough({
    agent: 'codex',
    evolution,
    runModel,
    states: {
      byUnitId: {
        'introduced:a': unitState,
        'introduced:b': unitState,
      },
      whole: baseState,
    },
    structure: 'units',
  });

  expect(result.status).toBe('ready');
  if (result.status !== 'ready') {
    return;
  }
  expect(runModel).toHaveBeenCalledTimes(2);
  expect(result.plan.structure).toBe('units');
  expect(result.walkthrough.chapters.length).toBeGreaterThan(0);
  expect(result.walkthrough.title).toContain('Commit-by-commit');
});

test('generateReviewWalkthrough fails clearly without whole state', async () => {
  const result = await generateReviewWalkthrough({
    agent: 'codex',
    runModel: async () => ({ draft }),
    states: {},
    structure: 'whole-diff',
  });
  expect(result).toEqual({
    reason: 'Whole-diff walkthrough generation requires a whole RepositoryState.',
    status: 'failed',
  });
});

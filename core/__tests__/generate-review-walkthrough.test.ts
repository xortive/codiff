import { expect, test, vi } from 'vite-plus/test';
import { generateReviewWalkthrough } from '../lib/generate-review-walkthrough.ts';
import type {
  RepositoryState,
  ReviewCommitEvolution,
  WalkthroughGenerationProgress,
} from '../types.ts';
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

  let releaseModels: () => void;
  const modelsReady = new Promise<void>((resolve) => {
    releaseModels = resolve;
  });
  const runModel = vi.fn(async () => {
    await modelsReady;
    return { draft };
  });
  const progressUpdates: Array<WalkthroughGenerationProgress> = [];
  const overviewPrompts: Array<string> = [];
  const runOverviewModel = vi.fn(async ({ prompt }: { prompt: string }) => {
    overviewPrompts.push(prompt);
    return { focus: 'The added commits establish the feature in two ordered steps.' };
  });
  const unitState = {
    ...baseState,
    files: [createChangedFile('src/unit.ts')],
  } satisfies RepositoryState;

  const generation = generateReviewWalkthrough({
    agent: 'codex',
    evolution,
    onProgress: (progress) => progressUpdates.push(progress),
    runModel,
    runOverviewModel,
    states: {
      byUnitId: {
        'introduced:a': unitState,
        'introduced:b': unitState,
      },
      whole: baseState,
    },
    structure: 'units',
  });
  expect(runModel).toHaveBeenCalledTimes(2);
  releaseModels!();
  const result = await generation;

  expect(result.status).toBe('ready');
  if (result.status !== 'ready') {
    return;
  }
  expect(runModel).toHaveBeenCalledTimes(2);
  expect(runOverviewModel).toHaveBeenCalledTimes(1);
  expect(overviewPrompts).toEqual([expect.stringContaining('"kind":"added"')]);
  expect(result.walkthrough.focus).toBe(
    'The added commits establish the feature in two ordered steps.',
  );
  expect(result.walkthrough.chapters[0]?.commit?.versionCommitKind).toBe('introduced');
  expect(result.plan.structure).toBe('units');
  expect(result.walkthrough.chapters.length).toBeGreaterThan(0);
  expect(result.walkthrough.title).toContain('Commit-by-commit');
  expect(progressUpdates).toContainEqual(
    expect.objectContaining({
      phase: 'generating-units',
      total: 2,
      units: expect.arrayContaining([expect.objectContaining({ status: 'generating' })]),
    }),
  );
  expect(progressUpdates).toContainEqual(
    expect.objectContaining({ phase: 'combining', summary: 'Composing commit walkthroughs.' }),
  );
});

test('generateReviewWalkthrough authors ordinary commit units with commit context', async () => {
  const commitUnit = {
    commit: {
      authoredAt: '2026-01-01T00:00:00.000Z',
      authorName: 'Ada',
      parentIds: ['0'.repeat(40)],
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      subject: 'Add the request path',
    },
    id: `commit:${'a'.repeat(40)}`,
    kind: 'commit' as const,
    order: 0,
    reviewable: true as const,
  };
  const prompts: Array<string> = [];
  const result = await generateReviewWalkthrough({
    agent: 'codex',
    plan: { structure: 'units', units: [commitUnit] },
    runModel: async ({ prompt }) => {
      prompts.push(prompt);
      return { draft };
    },
    states: {
      byUnitId: { [commitUnit.id]: baseState },
      whole: baseState,
    },
  });

  expect(result.status).toBe('ready');
  if (result.status !== 'ready') {
    return;
  }
  expect(prompts[0]).toContain('This is an independent walkthrough for commit');
  expect(prompts[0]).not.toContain('version comparison');
  expect(result.walkthrough.chapters[0]?.commit).toMatchObject({
    gitSha: commitUnit.commit.sha,
    sha: commitUnit.commit.sha,
  });
  expect(result.walkthrough.commitFiles).toEqual(baseState.files);
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

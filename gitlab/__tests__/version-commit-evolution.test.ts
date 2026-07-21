import type { ChangedFile } from '@nkzw/codiff-core/types';
import { describe, expect, test } from 'vite-plus/test';
import {
  attributeRebaseDrivers,
  createCommitPatchSignature,
  matchVersionCommitStacks,
  recommendVersionWalkthroughStructure,
  scoreBaseCommitAsRebaseDriver,
  type CommitPatchSignature,
} from '../src/version-commit-evolution.ts';

const endpoint = (id: string, headSha: string) => ({
  baseSha: `base-${id}`,
  createdAt: '2026-07-15T00:00:00.000Z',
  headSha,
  id,
  label: `v${id}`,
  startSha: `base-${id}`,
});

const commit = (index: number, generation: 'new' | 'old' = 'old') => ({
  authoredDate: `2026-07-15T00:${String(index).padStart(2, '0')}:00.000Z`,
  authorName: 'Ada',
  message: `Change logical unit ${index}`,
  parentIds: index === 1 ? [`${generation}-base`] : [`${generation}-${index - 1}`],
  sha: `${generation}-${index}`,
  shortSha: `${generation[0]}${index}`,
  title: `Change logical unit ${index}`,
  webUrl: `https://gitlab.example/commit/${generation}-${index}`,
});

const signature = (
  sha: string,
  index: number,
  patchId: string,
  revision = 'same',
): CommitPatchSignature => ({
  additions: 10 + index,
  changedPaths: [`src/unit-${index}.ts`],
  changeTokenSketch: [`token-${index}`, `revision-${revision}`],
  commitSha: sha,
  deletions: index,
  exactPatchId: patchId,
  filesChanged: 1,
  subjectKey: `change logical unit ${index}`,
});

const changedFile = (offset: number): ChangedFile => ({
  fingerprint: String(offset),
  path: 'src/app.ts',
  sections: [
    {
      binary: false,
      id: String(offset),
      kind: 'commit',
      loadState: 'ready',
      patch: `diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -${offset},1 +${offset},1 @@\n-old value\n+new value\n`,
    },
  ],
  status: 'modified',
});

describe('version commit evolution', () => {
  test('returns only revised logical commits 2, 4, and 6 as reviewable after a rebase', async () => {
    const oldCommits = Array.from({ length: 10 }, (_, index) => commit(index + 1));
    const newCommits = Array.from({ length: 10 }, (_, index) => commit(index + 1, 'new'));
    const revised = new Set([2, 4, 6]);
    const signatures = new Map<string, CommitPatchSignature>();
    for (let index = 1; index <= 10; index += 1) {
      signatures.set(
        `old-${index}`,
        signature(`old-${index}`, index, `patch-${index}`, revised.has(index) ? 'old' : 'same'),
      );
      signatures.set(
        `new-${index}`,
        signature(
          `new-${index}`,
          index,
          revised.has(index) ? `revised-patch-${index}` : `patch-${index}`,
          revised.has(index) ? 'new' : 'same',
        ),
      );
    }
    const evolution = await matchVersionCommitStacks({
      from: endpoint('2', 'old-10'),
      newCommits,
      oldCommits,
      signatures,
      to: endpoint('6', 'new-10'),
    });

    expect(
      evolution.units.filter((unit) => unit.reviewable).map((unit) => unit.before?.sha),
    ).toEqual(['old-2', 'old-4', 'old-6']);
    expect(evolution.summary).toMatchObject({
      reviewable: 3,
      revised: 3,
      rewrittenSamePatch: 7,
    });
    expect(evolution.recommendation.structure).toBe('commit-by-commit');
  });

  test('keeps duplicate patch IDs unmatched instead of forcing identity', async () => {
    const oldCommits = [commit(1), commit(2)];
    const newCommits = [commit(1, 'new'), commit(2, 'new')];
    const signatures = new Map<string, CommitPatchSignature>([
      ['old-1', signature('old-1', 1, 'duplicate')],
      ['old-2', signature('old-2', 2, 'duplicate')],
      ['new-1', signature('new-1', 1, 'duplicate')],
      ['new-2', signature('new-2', 2, 'duplicate')],
    ]);
    const evolution = await matchVersionCommitStacks({
      from: endpoint('1', 'old-2'),
      newCommits,
      oldCommits,
      signatures,
      to: endpoint('2', 'new-2'),
    });
    expect(evolution.summary.rewrittenSamePatch).toBe(0);
  });

  test('keeps commits unclassified when patch evidence or one stack is unavailable', async () => {
    const oldCommits = [commit(1)];
    const newCommits = [commit(1, 'new')];
    const withoutPatches = await matchVersionCommitStacks({
      from: endpoint('1', 'old-1'),
      newCommits,
      oldCommits,
      signatures: new Map(),
      to: endpoint('2', 'new-1'),
    });
    expect(withoutPatches.summary).toMatchObject({ added: 0, ambiguous: 2, removed: 0 });
    expect(withoutPatches.units.every((unit) => !unit.reviewable)).toBe(true);

    const withOnlyLaterStack = await matchVersionCommitStacks({
      from: endpoint('1', 'old-1'),
      newCommits,
      oldCommits: [],
      signatures: new Map([['new-1', signature('new-1', 1, 'new-patch')]]),
      stackCompleteness: { new: true, old: false },
      to: endpoint('2', 'new-1'),
    });
    expect(withOnlyLaterStack.summary).toMatchObject({ added: 0, ambiguous: 1, removed: 0 });
    expect(withOnlyLaterStack.units[0]?.matchReasons).toContain(
      'Insufficient evidence to classify this commit as new',
    );

    const unrelatedNewCommit = {
      ...newCommits[0]!,
      authorName: 'Lin',
      message: 'Replace an unrelated subsystem',
      title: 'Replace an unrelated subsystem',
    };
    const unrelatedNewSignature = {
      ...signature('new-1', 1, 'unrelated-patch'),
      additions: 1000,
      changedPaths: ['unrelated/file.ts'],
      changeTokenSketch: ['unrelated-token'],
      subjectKey: 'replace an unrelated subsystem',
    };
    const unrelatedChanges = await matchVersionCommitStacks({
      from: endpoint('1', 'old-1'),
      newCommits: [unrelatedNewCommit],
      oldCommits,
      signatures: new Map([
        ['old-1', signature('old-1', 1, 'old-patch')],
        ['new-1', unrelatedNewSignature],
      ]),
      to: endpoint('2', 'new-1'),
    });
    expect(unrelatedChanges.summary).toMatchObject({ added: 1, ambiguous: 0, removed: 1 });
  });

  test('classifies earlier MR commits rewritten into the later target base', async () => {
    const oldCommits = [commit(1), commit(2), commit(3)];
    const newCommits = [commit(3, 'new'), commit(4, 'new'), commit(5, 'new')];
    const baseCommits = [
      { ...commit(1, 'new'), sha: 'base-1', shortSha: 'b1' },
      { ...commit(2, 'new'), sha: 'base-2', shortSha: 'b2' },
    ];
    const signatures = new Map<string, CommitPatchSignature>([
      ['old-1', signature('old-1', 1, 'old-patch-1', 'old')],
      ['old-2', signature('old-2', 2, 'old-patch-2', 'old')],
      ['old-3', signature('old-3', 3, 'old-patch-3', 'old')],
      ['base-1', signature('base-1', 1, 'base-patch-1', 'new')],
      ['base-2', signature('base-2', 2, 'base-patch-2', 'new')],
      ['new-3', signature('new-3', 3, 'new-patch-3', 'new')],
      ['new-4', signature('new-4', 4, 'new-patch-4')],
      ['new-5', signature('new-5', 5, 'new-patch-5')],
    ]);

    const evolution = await matchVersionCommitStacks({
      baseCommits,
      from: endpoint('1', 'old-3'),
      newCommits,
      oldCommits,
      signatures,
      to: endpoint('2', 'new-5'),
    });

    expect(evolution.summary).toMatchObject({
      absorbedIntoBase: 2,
      added: 2,
      ambiguous: 0,
      reviewable: 3,
      revised: 1,
    });
    expect(
      evolution.units
        .filter((unit) => unit.kind === 'absorbed-into-base')
        .map((unit) => [unit.before?.sha, unit.baseCommit?.sha]),
    ).toEqual([
      ['old-1', 'base-1'],
      ['old-2', 'base-2'],
    ]);
    expect(evolution.recommendation.structure).toBe('commit-by-commit');
  });

  test('normalizes hunk offsets and stores only hashed changed-line tokens', async () => {
    const first = await createCommitPatchSignature({ sha: 'a', title: 'Update app' }, [
      changedFile(1),
    ]);
    const second = await createCommitPatchSignature({ sha: 'b', title: 'Update app' }, [
      changedFile(100),
    ]);
    expect(first.exactPatchId).toBe(second.exactPatchId);
    expect(JSON.stringify(first.changeTokenSketch)).not.toContain('value');
  });

  test('recommends structure from content confidence without an upper commit-count bound', () => {
    expect(
      recommendVersionWalkthroughStructure({ ambiguous: 0, pairingCoverage: 1, reviewable: 1 })
        .structure,
    ).toBe('whole-diff');
    expect(
      recommendVersionWalkthroughStructure({ ambiguous: 0, pairingCoverage: 0.5, reviewable: 3 })
        .structure,
    ).toBe('whole-diff');
    expect(
      recommendVersionWalkthroughStructure({ ambiguous: 0, pairingCoverage: 1, reviewable: 30 })
        .structure,
    ).toBe('commit-by-commit');
  });
});

describe('rebase driver attribution', () => {
  test('scores overlapping base commits as likely drivers', () => {
    const unitSignature = {
      additions: 12,
      changedPaths: ['src/auth.ts', 'src/session.ts'],
      changeTokenSketch: ['token', 'session', 'refresh'],
      commitSha: 'unit',
      deletions: 4,
      exactPatchId: 'unit-patch',
      filesChanged: 2,
      subjectKey: 'preserve empty fields',
    } satisfies CommitPatchSignature;
    const overlapping = scoreBaseCommitAsRebaseDriver({
      baseSignature: {
        additions: 20,
        changedPaths: ['src/auth.ts', 'src/login.ts'],
        changeTokenSketch: ['token', 'login'],
        deletions: 3,
      },
      unitSignature,
    });
    const unrelated = scoreBaseCommitAsRebaseDriver({
      baseSignature: {
        additions: 8,
        changedPaths: ['docs/readme.md'],
        changeTokenSketch: ['docs', 'readme'],
        deletions: 1,
      },
      unitSignature,
    });
    expect(overlapping.overlappingPaths).toEqual(['src/auth.ts']);
    expect(overlapping.score).toBeGreaterThan(unrelated.score);
    expect(overlapping.score).toBeGreaterThanOrEqual(0.22);
  });

  test('returns ranked overlapping base commits only', () => {
    const unitSignature = {
      additions: 10,
      changedPaths: ['src/auth.ts'],
      changeTokenSketch: ['token'],
      commitSha: 'unit',
      deletions: 2,
      exactPatchId: 'unit-patch',
      filesChanged: 1,
      subjectKey: 'preserve empty fields',
    } satisfies CommitPatchSignature;
    const baseSignatures = new Map<string, CommitPatchSignature>([
      [
        'base-strong',
        {
          additions: 15,
          changedPaths: ['src/auth.ts', 'src/token.ts'],
          changeTokenSketch: ['token', 'auth'],
          commitSha: 'base-strong',
          deletions: 2,
          exactPatchId: 'base-strong',
          filesChanged: 2,
          subjectKey: 'harden auth tokens',
        },
      ],
      [
        'base-weak',
        {
          additions: 4,
          changedPaths: ['src/auth.ts'],
          changeTokenSketch: ['format'],
          commitSha: 'base-weak',
          deletions: 1,
          exactPatchId: 'base-weak',
          filesChanged: 1,
          subjectKey: 'format auth file',
        },
      ],
      [
        'base-unrelated',
        {
          additions: 30,
          changedPaths: ['package.json'],
          changeTokenSketch: ['deps'],
          commitSha: 'base-unrelated',
          deletions: 5,
          exactPatchId: 'base-unrelated',
          filesChanged: 1,
          subjectKey: 'bump deps',
        },
      ],
    ]);
    const drivers = attributeRebaseDrivers({
      baseCommits: [
        {
          authoredAt: '2026-07-01T00:00:00.000Z',
          authorName: 'Ada',
          sha: 'base-strong',
          shortSha: 'strong',
          subject: 'Harden auth tokens',
          webUrl: 'https://gitlab.example/base-strong',
        },
        {
          authoredAt: '2026-07-02T00:00:00.000Z',
          authorName: 'Grace',
          sha: 'base-weak',
          shortSha: 'weak',
          subject: 'Format auth file',
          webUrl: 'https://gitlab.example/base-weak',
        },
        {
          authoredAt: '2026-07-03T00:00:00.000Z',
          authorName: 'Lin',
          sha: 'base-unrelated',
          shortSha: 'unrel',
          subject: 'Bump deps',
          webUrl: 'https://gitlab.example/base-unrelated',
        },
      ],
      baseSignatures,
      unitSignature,
    });
    expect(drivers.map((driver) => driver.sha)).toEqual(['base-strong', 'base-weak']);
    expect(drivers[0]?.overlappingPaths).toEqual(['src/auth.ts']);
  });
});

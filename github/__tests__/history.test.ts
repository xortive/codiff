import {
  createCommitPatchSignature,
  matchVersionCommitStacks,
  projectCommitEvolution,
} from '@nkzw/codiff-core';
import type { ChangedFile } from '@nkzw/codiff-core/types';
import { expect, test } from 'vite-plus/test';
import {
  buildBaseMovement,
  compareGitHubReviewVersions,
  listGitHubReviewVersions,
  normalizeForcePushEvent,
  type GitHubCommitLike,
  type GitHubHistoryGit,
} from '../src/history.ts';
import { createFakeGitHubTransport } from '../src/transport.ts';

test('normalizeForcePushEvent accepts head_ref_force_pushed timeline payloads', () => {
  const event = normalizeForcePushEvent({
    after: 'b'.repeat(40),
    before: 'a'.repeat(40),
    created_at: '2026-01-02T00:00:00.000Z',
    event: 'head_ref_force_pushed',
  });
  expect(event).toEqual({
    after: 'b'.repeat(40),
    before: 'a'.repeat(40),
    createdAt: '2026-01-02T00:00:00.000Z',
  });
});

test('compareGitHubReviewVersions uses a direct head-to-head diff', async () => {
  const base = '0'.repeat(40);
  const before = 'a'.repeat(40);
  const after = 'b'.repeat(40);
  const readRangeFilesCalls: Array<[string, string, boolean]> = [];
  const versions = [
    {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: before,
      range: {
        base: { commitId: base, label: { kind: 'commit' as const, text: 'base' } },
        head: { commitId: before, label: { kind: 'version' as const, text: 'before' } },
      },
    },
    {
      createdAt: '2026-01-02T00:00:00.000Z',
      id: after,
      range: {
        base: { commitId: base, label: { kind: 'commit' as const, text: 'base' } },
        head: { commitId: after, label: { kind: 'version' as const, text: 'after' } },
      },
    },
  ];
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async () => false,
    mergeBase: async () => base,
    readCommitDiff: async () => [],
    readCommitMeta: async (sha) => ({
      authoredAt: '2026-01-01T00:00:00.000Z',
      authorName: 'Ada',
      parentIds: [],
      sha,
      shortSha: sha.slice(0, 7),
      subject: sha.slice(0, 7),
    }),
    readCommitStack: async () => [],
    readRangeFiles: async (from, to, symmetric) => {
      readRangeFilesCalls.push([from, to, symmetric]);
      return [];
    },
  };

  const result = await compareGitHubReviewVersions({
    git,
    pull: { number: 12, owner: 'nkzw-tech', repo: 'codiff' },
    range: { fromId: before, toId: after },
    versions,
  });

  expect(result.versionCompare.analysis.summary.empty).toBe(true);
  expect(readRangeFilesCalls[0]).toEqual([before, after, false]);
});

test('normalizeForcePushEvent ignores non-force-push timeline noise', () => {
  expect(
    normalizeForcePushEvent({
      created_at: '2026-01-02T00:00:00.000Z',
      event: 'commented',
    }),
  ).toBeNull();
});

test('listGitHubReviewVersions builds head timeline labels without GitLab version numbers', async () => {
  const before = 'a'.repeat(40);
  const after = 'b'.repeat(40);
  const current = 'c'.repeat(40);
  const base = '0'.repeat(40);
  const transport = createFakeGitHubTransport([
    {
      path: `/repos/nkzw-tech/codiff/issues/12/timeline`,
      response: [
        {
          actor: { login: 'ada' },
          after,
          before,
          created_at: '2026-01-02T00:00:00.000Z',
          event: 'head_ref_force_pushed',
        },
      ],
    },
    {
      path: `/repos/nkzw-tech/codiff/pulls/12`,
      response: {
        base: { sha: base },
        head: { sha: current },
      },
    },
  ]);

  const { versions, warning } = await listGitHubReviewVersions({
    git: {
      ensureCommit: async (sha) => sha,
      isAncestor: async () => false,
      mergeBase: async (_base, head) => (head === before ? '1'.repeat(40) : base),
      readCommitDiff: async () => [],
      readCommitMeta: async () => {
        throw new Error('unused');
      },
      readCommitStack: async () => [],
      readRangeFiles: async () => [],
    },
    pull: {
      number: 12,
      owner: 'nkzw-tech',
      repo: 'codiff',
    },
    transport,
  });

  expect(warning).toBeNull();
  expect(versions.map((version) => version.id)).toEqual([before, after, current]);
  const labels = versions.map((version) => version.range.head.label.text);
  expect(labels.some((label) => label.startsWith('Head ·'))).toBe(true);
  expect(labels.some((label) => label.startsWith('Force-push ·'))).toBe(true);
  expect(labels.at(-1)).toBe('Current head');
  expect(labels.every((label) => !/^v\d+/.test(label))).toBe(true);
  expect(versions.map((version) => version.range.base.commitId)).toEqual([
    '1'.repeat(40),
    base,
    base,
  ]);
});

const commit = (
  shaChar: string,
  subject: string,
  parent: string,
  authoredAt = '2026-01-01T00:00:00.000Z',
): GitHubCommitLike => {
  const sha = shaChar.repeat(40);
  return {
    authoredAt,
    authorName: 'Ada',
    parentIds: [parent],
    sha,
    shortSha: sha.slice(0, 7),
    subject,
  };
};

const patchFile = (filePath: string, body: string): ChangedFile => ({
  fingerprint: filePath,
  path: filePath,
  sections: [
    {
      binary: false,
      id: filePath,
      kind: 'commit',
      patch: body,
    },
  ],
  status: 'modified',
});

test('buildBaseMovement classifies forward base advances with commitsBetween + diffStat', async () => {
  const oldBase = '1'.repeat(40);
  const mid = commit('2', 'base: mid', oldBase, '2026-01-01T01:00:00.000Z');
  const newBase = commit('3', 'base: tip', mid.sha, '2026-01-01T02:00:00.000Z');

  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async (ancestor, descendant) => {
      // oldBase < mid < newBase
      if (ancestor === oldBase && (descendant === mid.sha || descendant === newBase.sha)) {
        return true;
      }
      if (ancestor === mid.sha && descendant === newBase.sha) {
        return true;
      }
      if (ancestor === descendant) {
        return true;
      }
      return false;
    },
    mergeBase: async () => oldBase,
    readCommitDiff: async () => [],
    readCommitMeta: async (sha) => {
      if (sha === oldBase) {
        return {
          authoredAt: '2026-01-01T00:00:00.000Z',
          authorName: 'Ada',
          parentIds: [],
          sha: oldBase,
          shortSha: oldBase.slice(0, 7),
          subject: 'base: root',
        };
      }
      if (sha === mid.sha) {
        return mid;
      }
      if (sha === newBase.sha) {
        return newBase;
      }
      throw new Error(`unknown ${sha}`);
    },
    readCommitStack: async (base, head) => {
      if (base === oldBase && head === newBase.sha) {
        return [mid, newBase];
      }
      return [];
    },
    readRangeFiles: async () => [patchFile('src/a.ts', '@@ -1 +1 @@\n-old\n+new\n')],
  };

  const movement = await buildBaseMovement({
    fromBase: oldBase,
    git,
    toBase: newBase.sha,
  });

  expect(movement.changed).toBe(true);
  expect(movement.relationship).toBe('forward');
  expect(movement.commitsBetween).toBe(2);
  expect(movement.commits?.map((entry) => entry.sha)).toEqual([mid.sha, newBase.sha]);
  expect(movement.diffStat).toEqual({ additions: 1, deletions: 1, filesChanged: 1 });
  expect(movement.commitTimestampDeltaMs).toBe(
    Date.parse(newBase.authoredAt) - Date.parse('2026-01-01T00:00:00.000Z'),
  );
});

test('buildBaseMovement classifies backward base moves', async () => {
  const oldBase = commit('a', 'old tip', '0'.repeat(40));
  const newBase = '0'.repeat(40);
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async (ancestor, descendant) => ancestor === newBase && descendant === oldBase.sha,
    mergeBase: async () => newBase,
    readCommitDiff: async () => [],
    readCommitMeta: async (sha) => {
      if (sha === oldBase.sha) {
        return oldBase;
      }
      return {
        authoredAt: '2026-01-01T00:00:00.000Z',
        authorName: 'Ada',
        parentIds: [],
        sha: newBase,
        shortSha: newBase.slice(0, 7),
        subject: 'root',
      };
    },
    readCommitStack: async (base, head) => {
      if (base === newBase && head === oldBase.sha) {
        return [oldBase];
      }
      return [];
    },
    readRangeFiles: async () => [],
  };

  const movement = await buildBaseMovement({
    fromBase: oldBase.sha,
    git,
    toBase: newBase,
  });
  expect(movement.relationship).toBe('backward');
  expect(movement.commitsBetween).toBe(1);
});

test('buildBaseMovement classifies divergent bases', async () => {
  const fromBase = 'a'.repeat(40);
  const toBase = 'b'.repeat(40);
  const tip = commit('c', 'on new base', toBase);
  const git: GitHubHistoryGit = {
    ensureCommit: async (sha) => sha,
    isAncestor: async () => false,
    mergeBase: async () => fromBase,
    readCommitDiff: async () => [],
    readCommitMeta: async (sha) => ({
      authoredAt: '2026-01-01T00:00:00.000Z',
      authorName: 'Ada',
      parentIds: [],
      sha,
      shortSha: sha.slice(0, 7),
      subject: 'base',
    }),
    readCommitStack: async (base, head) => {
      if (base === fromBase && head === toBase) {
        return [tip];
      }
      return [];
    },
    readRangeFiles: async () => [],
  };
  const movement = await buildBaseMovement({ fromBase, git, toBase });
  expect(movement.relationship).toBe('divergent');
  expect(movement.commitsBetween).toBe(1);
});

test('signature evolution classifies retained/revised/introduced via patch matching', async () => {
  const base = '0'.repeat(40);
  const oldA = commit('a', 'feat: one', base);
  const oldB = commit('b', 'feat: two', oldA.sha);
  const newA = { ...oldA }; // same sha retained
  const newB = commit('c', 'feat: two', newA.sha); // rewritten same subject, same patch
  const newC = commit('d', 'feat: three', newB.sha); // introduced

  const filesFor = (sha: string): Array<ChangedFile> => {
    if (sha === oldA.sha || sha === newA.sha) {
      return [patchFile('one.ts', '@@ -1 +1 @@\n-a\n+b\n')];
    }
    if (sha === oldB.sha || sha === newB.sha) {
      return [patchFile('two.ts', '@@ -1 +1 @@\n-x\n+y\n')];
    }
    if (sha === newC.sha) {
      return [patchFile('three.ts', '@@ -0,0 +1 @@\n+z\n')];
    }
    return [];
  };

  const signatures = new Map();
  for (const entry of [oldA, oldB, newB, newC]) {
    signatures.set(
      entry.sha,
      await createCommitPatchSignature(
        {
          sha: entry.sha,
          title: entry.subject,
        },
        filesFor(entry.sha),
      ),
    );
  }

  const evolution = projectCommitEvolution(
    await matchVersionCommitStacks({
      from: { baseSha: base, headSha: oldB.sha, id: 'from' },
      newCommits: [newA, newB, newC].map((entry) => ({
        authoredDate: entry.authoredAt,
        authorName: entry.authorName,
        message: entry.subject,
        parentIds: entry.parentIds,
        sha: entry.sha,
        shortSha: entry.shortSha,
        title: entry.subject,
        webUrl: '',
      })),
      oldCommits: [oldA, oldB].map((entry) => ({
        authoredDate: entry.authoredAt,
        authorName: entry.authorName,
        message: entry.subject,
        parentIds: entry.parentIds,
        sha: entry.sha,
        shortSha: entry.shortSha,
        title: entry.subject,
        webUrl: '',
      })),
      signatures,
      to: { baseSha: base, headSha: newC.sha, id: 'to' },
    }),
  );

  expect(evolution.units.some((unit) => unit.kind === 'retained')).toBe(true);
  expect(
    evolution.units.some((unit) => unit.kind === 'rewritten-same-patch' || unit.kind === 'revised'),
  ).toBe(true);
  expect(evolution.units.some((unit) => unit.kind === 'introduced')).toBe(true);
  expect(evolution.summary.added).toBeGreaterThanOrEqual(1);
});

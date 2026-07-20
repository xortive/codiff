import { expect, test } from 'vite-plus/test';
import {
  createFakeGitLabTransport,
  fetchGitLabMergeRequestVersions,
  projectCommitEvolution,
  projectReviewPlan,
  projectVersionCompare,
  toGitLabDiffIdentity,
} from '../src/index.ts';
import { matchVersionCommitStacks, createCommitPatchSignature } from '../src/version-commit-evolution.ts';

test('loads merge request versions through the injected transport', async () => {
  const transport = createFakeGitLabTransport([
    {
      path: '/api/v4/projects/group%2Fproject/merge_requests/7/versions',
      response: [
        {
          id: 2,
          head_commit_sha: 'b'.repeat(40),
          base_commit_sha: 'a'.repeat(40),
          start_commit_sha: 'a'.repeat(40),
          created_at: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 1,
          head_commit_sha: 'c'.repeat(40),
          base_commit_sha: 'a'.repeat(40),
          start_commit_sha: 'a'.repeat(40),
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  ]);

  const versions = await fetchGitLabMergeRequestVersions({
    iid: 7,
    projectPath: 'group/project',
    transport,
  });

  expect(versions).toHaveLength(2);
  expect(versions[0]?.id).toBe('2');
  expect(versions[0]?.label).toContain('v2');
  expect(toGitLabDiffIdentity(versions[0]!).headSha).toBe('b'.repeat(40));
  expect(transport.calls[0]?.path).toContain('/merge_requests/7/versions');
});

test('projects algorithm evolution into Core review plans', async () => {
  const from = {
    baseSha: 'a'.repeat(40),
    createdAt: '2026-01-01T00:00:00.000Z',
    headSha: 'b'.repeat(40),
    id: '1',
    label: 'v1',
    startSha: 'a'.repeat(40),
  };
  const to = {
    baseSha: 'a'.repeat(40),
    createdAt: '2026-01-02T00:00:00.000Z',
    headSha: 'c'.repeat(40),
    id: '2',
    label: 'v2',
    startSha: 'a'.repeat(40),
  };
  const oldCommit = {
    authoredDate: '2026-01-01T00:00:00.000Z',
    authorName: 'Ada',
    message: 'feat: one\n',
    parentIds: [from.baseSha],
    sha: 'd'.repeat(40),
    shortSha: 'ddddddd',
    title: 'feat: one',
    webUrl: 'https://example.test/d',
  };
  const newCommit = {
    ...oldCommit,
    sha: 'e'.repeat(40),
    shortSha: 'eeeeeee',
  };
  const files = [
    {
      fingerprint: 'f',
      path: 'a.ts',
      sections: [
        {
          binary: false,
          id: 'a.ts:commit:1',
          kind: 'commit' as const,
          patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
        },
      ],
      status: 'modified' as const,
    },
  ];
  const oldSig = await createCommitPatchSignature(oldCommit, files);
  const newSig = await createCommitPatchSignature(newCommit, files);
  const evolution = await matchVersionCommitStacks({
    from,
    newCommits: [newCommit],
    oldCommits: [oldCommit],
    signatures: new Map([
      [oldCommit.sha, oldSig],
      [newCommit.sha, newSig],
    ]),
    to,
  });
  const projected = projectCommitEvolution(evolution);
  expect(projected.units.some((unit) => unit.kind === 'revised' || unit.kind === 'rewritten-same-patch' || unit.kind === 'retained')).toBe(
    true,
  );
  const plan = projectReviewPlan({ evolution, structure: 'auto' });
  expect(plan.structure === 'whole-diff' || plan.structure === 'units').toBe(true);
});

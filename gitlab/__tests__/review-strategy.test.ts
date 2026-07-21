import { expect, test } from 'vite-plus/test';
import {
  classifyGitLabCommit,
  classifyMergeRequestReviewStrategy,
  versionCompareReviewStructureKey,
  orderCommitsTopologically,
  overrideMergeRequestReviewStrategy,
  type GitLabMergeRequestCommitLike,
} from '../src/review-strategy.ts';

const commit = (
  overrides: Partial<GitLabMergeRequestCommitLike> &
    Pick<GitLabMergeRequestCommitLike, 'sha' | 'title'>,
): GitLabMergeRequestCommitLike => ({
  authoredDate: '2026-07-01T00:00:00.000Z',
  authorName: 'Ada',
  message: overrides.title,
  parentIds: ['parent'],
  shortSha: overrides.sha.slice(0, 8),
  ...overrides,
});

test('classifies fixup and review-response subjects', () => {
  expect(classifyGitLabCommit(commit({ sha: 'aaaaaaaa', title: 'fixup! add gate' })).role).toBe(
    'fixup',
  );
  expect(
    classifyGitLabCommit(commit({ sha: 'bbbbbbbb', title: 'Address review comments' })).role,
  ).toBe('review-response');
  expect(classifyGitLabCommit(commit({ sha: 'cccccccc', title: 'feat: add gate' })).role).toBe(
    'feature',
  );
});

test('prefers whole-mr for single commits and fixup-heavy histories', () => {
  expect(
    classifyMergeRequestReviewStrategy({
      commits: [commit({ sha: 'aaaaaaaa', title: 'feat: only one' })],
      description: '',
      title: 'One change',
    }),
  ).toMatchObject({ mode: 'whole-mr', reason: 'single-commit' });

  expect(
    classifyMergeRequestReviewStrategy({
      commits: [
        commit({ sha: 'aaaaaaaa', title: 'feat: start' }),
        commit({ sha: 'bbbbbbbb', title: 'fixup! start' }),
        commit({ sha: 'cccccccc', title: 'Address review comments' }),
        commit({ sha: 'dddddddd', title: 'nits' }),
      ],
      description: '',
      title: 'WIP',
    }),
  ).toMatchObject({ mode: 'whole-mr', reason: 'fixup-style' });
});

test('detects explicit commit-by-commit requests and chapter-shaped stacks', () => {
  expect(
    classifyMergeRequestReviewStrategy({
      commits: [
        commit({ sha: 'aaaaaaaa', title: 'feat: model' }),
        commit({ sha: 'bbbbbbbb', title: 'test: cover model' }),
      ],
      description: 'Please review commit by commit.',
      title: 'Stack',
    }),
  ).toMatchObject({ mode: 'commit-by-commit', reason: 'explicit-description' });

  expect(
    classifyMergeRequestReviewStrategy({
      commits: [
        commit({ sha: 'aaaaaaaa', title: 'feat: add endpoint' }),
        commit({ sha: 'bbbbbbbb', title: 'test: cover endpoint' }),
        commit({ sha: 'cccccccc', title: 'docs: document endpoint' }),
      ],
      description: '',
      title: 'Endpoint stack',
    }),
  ).toMatchObject({ mode: 'commit-by-commit' });
});
test('treats a short distinct descriptive history as commit-by-commit', () => {
  expect(
    classifyMergeRequestReviewStrategy({
      commits: [
        commit({ sha: 'aaaaaaaa', title: 'Add the request path' }),
        commit({ sha: 'bbbbbbbb', title: 'Handle retries' }),
      ],
      description: '',
      title: 'Request handling',
    }),
  ).toMatchObject({ mode: 'commit-by-commit', reason: 'chapter-shaped' });
});

test('honors explicit whole-mr language over chapter shape', () => {
  expect(
    classifyMergeRequestReviewStrategy({
      commits: [
        commit({ sha: 'aaaaaaaa', title: 'feat: a' }),
        commit({ sha: 'bbbbbbbb', title: 'feat: b' }),
      ],
      description: 'Please review as a whole; squash on merge.',
      title: 'Two features',
    }),
  ).toMatchObject({ mode: 'whole-mr', reason: 'explicit-whole' });
});

test('supports user overrides for walkthrough structure', () => {
  const base = classifyMergeRequestReviewStrategy({
    commits: [
      commit({ sha: 'aaaaaaaa', title: 'feat: a' }),
      commit({ sha: 'bbbbbbbb', title: 'test: a' }),
    ],
    description: '',
    title: 'Stack',
  });
  expect(overrideMergeRequestReviewStrategy(base, 'whole-mr')).toMatchObject({
    mode: 'whole-mr',
    reason: 'user-override',
  });
  expect(overrideMergeRequestReviewStrategy(base, 'commit-by-commit')).toMatchObject({
    mode: 'commit-by-commit',
    reason: 'user-override',
  });
  const forcedCommitStrategy = overrideMergeRequestReviewStrategy(
    { confidence: 1, mode: 'whole-mr', reason: 'default' },
    'commit-by-commit',
    [commit({ sha: 'cccccccc', title: 'Add routing' })],
  );
  expect(forcedCommitStrategy).toMatchObject({
    commits: [expect.objectContaining({ sha: 'cccccccc' })],
    mode: 'commit-by-commit',
    reason: 'user-override',
  });
});

test('builds version-comparison walkthrough cache structure keys', () => {
  expect(versionCompareReviewStructureKey('1', '2')).toBe('version-compare:1:2:whole-diff');
  expect(versionCompareReviewStructureKey('1', '2', 'commit-by-commit')).toBe(
    'version-compare:1:2:commit-by-commit',
  );
});

test('orders commits topologically from the merge-request base toward its head', () => {
  const oldest = classifyGitLabCommit(
    commit({ parentIds: ['base'], sha: 'aaaaaaaa', title: 'First' }),
  );
  const middle = classifyGitLabCommit(
    commit({ parentIds: [oldest.sha], sha: 'bbbbbbbb', title: 'Second' }),
  );
  const newest = classifyGitLabCommit(
    commit({ parentIds: [middle.sha], sha: 'cccccccc', title: 'Third' }),
  );

  expect(orderCommitsTopologically([newest, middle, oldest]).map((entry) => entry.sha)).toEqual([
    oldest.sha,
    middle.sha,
    newest.sha,
  ]);
});

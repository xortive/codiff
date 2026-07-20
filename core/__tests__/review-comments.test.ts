import { expect, test } from 'vite-plus/test';
import type { ReviewComment } from '../lib/app-types.ts';
import {
  findReusableReviewCommentDraft,
  getPendingPullRequestReviewComments,
  getReviewCommentsFromState,
  getVisibleReviewComments,
  toPullRequestReviewComment,
} from '../lib/review-comments.ts';
import type { RepositoryState } from '../types.ts';

const createReviewComment = (overrides: Partial<ReviewComment>): ReviewComment => ({
  body: 'A comment.',
  filePath: 'src/a.ts',
  id: 'github:1',
  lineNumber: 5,
  sectionId: 'src/a.ts:pull-request:1',
  side: 'additions',
  ...overrides,
});

const createPullRequestState = (): RepositoryState => ({
  branch: null,
  files: [
    {
      fingerprint: 'fingerprint',
      path: 'src/a.ts',
      sections: [
        {
          binary: false,
          id: 'src/a.ts:pull-request:1',
          kind: 'pull-request',
          patch: '',
        },
      ],
      status: 'modified',
    },
  ],
  generatedAt: 0,
  launchPath: '/repo',
  reviewComments: [
    {
      author: { login: 'reviewer' },
      body: 'Outdated comment.',
      filePath: 'src/a.ts',
      id: 'github:1',
      isOutdated: true,
      lineNumber: 5,
      side: 'additions',
    },
    {
      author: { login: 'reviewer' },
      body: 'Current comment.',
      filePath: 'src/a.ts',
      id: 'github:2',
      lineNumber: 6,
      side: 'additions',
    },
  ],
  root: '/repo',
  source: {
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/1',
  },
});

test('getReviewCommentsFromState carries the outdated flag through to review comments', () => {
  const comments = getReviewCommentsFromState(createPullRequestState());

  expect(comments).toHaveLength(2);
  expect(comments.find((comment) => comment.id === 'github:1')?.isOutdated).toBe(true);
  expect(comments.find((comment) => comment.id === 'github:2')?.isOutdated).toBeUndefined();
});

test('getReviewCommentsFromState derives the working-tree section from line coordinates', () => {
  const state = createPullRequestState();
  state.source = { type: 'working-tree' };
  state.files = [
    {
      ...state.files[0]!,
      sections: [
        {
          binary: false,
          id: 'src/a.ts:staged',
          kind: 'staged',
          patch:
            'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
        },
        {
          binary: false,
          id: 'src/a.ts:unstaged',
          kind: 'unstaged',
          patch:
            'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -5 +5 @@\n-old\n+new',
        },
      ],
    },
  ];
  state.reviewComments = [
    {
      author: { login: 'reviewer' },
      body: 'Persist this shared walkthrough comment.',
      filePath: 'src/a.ts',
      id: 'shared:1',
      lineNumber: 5,
      side: 'additions',
    },
  ];

  expect(getReviewCommentsFromState(state)).toEqual([
    expect.objectContaining({
      body: 'Persist this shared walkthrough comment.',
      id: 'shared:1',
      isReadOnly: true,
      sectionId: 'src/a.ts:unstaged',
    }),
  ]);
});

test('getPendingPullRequestReviewComments includes an unflushed active draft', () => {
  const comments = [
    createReviewComment({ body: '', id: 'draft' }),
    createReviewComment({ body: 'Already flushed.', id: 'ready', lineNumber: 6 }),
  ];

  expect(
    getPendingPullRequestReviewComments(comments, {
      ...comments[0],
      body: 'Still focused.',
    }).map((comment) => [comment.id, comment.body]),
  ).toEqual([
    ['draft', 'Still focused.'],
    ['ready', 'Already flushed.'],
  ]);
});

test('getPendingPullRequestReviewComments replaces a stale flushed draft', () => {
  const comments = [createReviewComment({ body: 'Old text.', id: 'draft' })];

  expect(
    getPendingPullRequestReviewComments(comments, {
      ...comments[0],
      body: 'New text.',
    }).map((comment) => comment.body),
  ).toEqual(['New text.']);
});

test('getPendingPullRequestReviewComments respects an emptied active draft', () => {
  const comments = [createReviewComment({ body: 'Old text.', id: 'draft' })];

  expect(
    getPendingPullRequestReviewComments(comments, {
      body: '   ',
      id: comments[0].id,
    }),
  ).toEqual([]);
});

test('getPendingPullRequestReviewComments ignores drafts outside the current review', () => {
  expect(
    getPendingPullRequestReviewComments([], {
      body: 'Stale text.',
      id: 'stale-draft',
    }),
  ).toEqual([]);
});

test('getPendingPullRequestReviewComments excludes comments being submitted individually', () => {
  const comment = createReviewComment({ body: 'Already submitting.', id: 'draft' });

  expect(
    getPendingPullRequestReviewComments([{ ...comment, remoteSubmit: { status: 'submitting' } }]),
  ).toEqual([]);
});

test('findReusableReviewCommentDraft preserves an active draft with unflushed content', () => {
  const activeDraft = createReviewComment({ body: '', id: 'active' });
  const reusableDraft = createReviewComment({ body: '', id: 'reusable', lineNumber: 6 });

  expect(
    findReusableReviewCommentDraft([activeDraft, reusableDraft], {
      body: 'Still typing.',
      id: activeDraft.id,
    }),
  ).toBe(reusableDraft);
});

test('findReusableReviewCommentDraft returns no draft when the only empty draft has content', () => {
  const activeDraft = createReviewComment({ body: '', id: 'active' });

  expect(
    findReusableReviewCommentDraft([activeDraft], {
      body: 'Still typing.',
      id: activeDraft.id,
    }),
  ).toBeUndefined();
});

test('findReusableReviewCommentDraft skips read-only drafts and reuses whitespace-only drafts', () => {
  const readOnlyDraft = createReviewComment({ body: '', id: 'readonly', isReadOnly: true });
  const activeDraft = createReviewComment({ body: '', id: 'active' });

  expect(
    findReusableReviewCommentDraft([readOnlyDraft, activeDraft], {
      body: '   ',
      id: activeDraft.id,
    }),
  ).toBe(activeDraft);
});

test('getReviewCommentsFromState carries GitLab discussion metadata through to review comments', () => {
  const state = createPullRequestState();
  state.reviewComments = [
    {
      author: { login: 'reviewer' },
      body: 'Resolvable comment.',
      canResolveThread: true,
      filePath: 'src/a.ts',
      id: 'gitlab:1',
      lineNumber: 5,
      side: 'additions',
      threadId: 'discussion-1',
    },
    {
      author: { login: 'reviewer' },
      body: 'Resolved comment.',
      filePath: 'src/a.ts',
      id: 'gitlab:2',
      isThreadResolved: true,
      lineNumber: 6,
      side: 'additions',
      threadId: 'discussion-2',
    },
  ];
  const comments = getReviewCommentsFromState(state);

  expect(comments.find((comment) => comment.id === 'gitlab:1')).toMatchObject({
    canResolveThread: true,
    threadId: 'discussion-1',
  });
  expect(comments.find((comment) => comment.id === 'gitlab:2')).toMatchObject({
    isThreadResolved: true,
    threadId: 'discussion-2',
  });
});

test('getReviewCommentsFromState preserves file-level GitLab anchors', () => {
  const state = createPullRequestState();
  state.reviewComments = [
    {
      anchor: 'file',
      author: { login: 'reviewer' },
      body: 'Review the file as a whole.',
      filePath: 'src/a.ts',
      id: 'gitlab:file',
    },
  ];

  expect(getReviewCommentsFromState(state)).toEqual([
    expect.objectContaining({
      anchor: 'file',
      body: 'Review the file as a whole.',
      filePath: 'src/a.ts',
      id: 'gitlab:file',
      isReadOnly: true,
      sectionId: 'src/a.ts:pull-request:1',
    }),
  ]);
});

test('getVisibleReviewComments hides outdated comments unless they are shown', () => {
  const comments = [
    createReviewComment({ id: 'github:1', isOutdated: true }),
    createReviewComment({ id: 'github:2' }),
  ];

  expect(getVisibleReviewComments(comments, false).map((comment) => comment.id)).toEqual([
    'github:2',
  ]);
  expect(getVisibleReviewComments(comments, true).map((comment) => comment.id)).toEqual([
    'github:1',
    'github:2',
  ]);
});

test('getVisibleReviewComments keeps user-authored comments that are never outdated', () => {
  const comments = [createReviewComment({ id: 'draft', isReadOnly: false })];

  expect(getVisibleReviewComments(comments, false)).toHaveLength(1);
});

test('serializes file-level thread replies without inventing line metadata', () => {
  expect(
    toPullRequestReviewComment(
      createReviewComment({
        anchor: 'file',
        body: 'Reply in the existing discussion.',
        lineNumber: undefined,
        side: undefined,
        threadId: 'discussion-1',
      }),
    ),
  ).toEqual({
    anchor: 'file',
    body: 'Reply in the existing discussion.',
    filePath: 'src/a.ts',
    threadId: 'discussion-1',
  });
});

test('omits UI-only section identity from review comment payloads', () => {
  const comment = createReviewComment({ body: 'Persist this comment.' });

  expect(toPullRequestReviewComment(comment)).not.toHaveProperty('sectionId');
});

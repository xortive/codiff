import { expect, test } from 'vite-plus/test';
import { resolveSubmittedShareReply, resolveSubmittedShareThread } from './react.tsx';

const comment = {
  body: 'Keep this visible while it saves.',
  filePath: 'src/review.ts',
  lineNumber: 12,
  side: 'additions',
} as const;

const message = {
  authorImage: 'https://github.com/ada.png',
  authorName: 'Ada Lovelace',
  authorUsername: 'ada',
  body: comment.body,
  canEdit: true,
  createdAt: '2026-07-16T12:00:00.000Z',
  id: 'message-1',
  threadId: 'thread-1',
  updatedAt: '2026-07-16T12:00:00.000Z',
};

test('resolves submitted share comments to their persisted server identity', () => {
  expect(
    resolveSubmittedShareReply({
      canResolveThread: true,
      comment: { ...comment, threadId: 'thread-1' },
      result: message,
    }),
  ).toMatchObject({
    author: {
      avatarUrl: 'https://github.com/ada.png',
      login: 'ada',
      name: 'Ada Lovelace',
    },
    body: comment.body,
    canDelete: true,
    canEdit: true,
    canResolveThread: true,
    id: 'message-1',
    submittedAt: '2026-07-16T12:00:00.000Z',
    threadId: 'thread-1',
  });

  expect(
    resolveSubmittedShareThread({
      canResolveThread: true,
      comment,
      result: {
        id: 'thread-1',
        messages: { items: [{ node: message }] },
      },
    }),
  ).toMatchObject({
    body: comment.body,
    id: 'message-1',
    threadId: 'thread-1',
  });
});

test('rejects incomplete mutation results instead of inventing a submitted comment', () => {
  expect(() =>
    resolveSubmittedShareThread({
      canResolveThread: false,
      comment,
      result: { id: 'thread-1', messages: { items: [] } },
    }),
  ).toThrow('Unable to load the submitted walkthrough comment.');
});

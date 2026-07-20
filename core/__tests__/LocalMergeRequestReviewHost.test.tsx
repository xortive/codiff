/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { beforeEach, expect, test, vi } from 'vite-plus/test';
import App from '../App.tsx';
import {
  LocalMergeRequestReviewHost,
  shouldUseLocalMergeRequestHost,
} from '../app/LocalMergeRequestReviewHost.tsx';
import { createDefaultConfig, defaultSettings } from '../config/defaults.ts';
import type { NarrativeWalkthrough, RepositoryState, ReviewSource } from '../types.ts';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

const reactActEnvironment = globalThis as typeof globalThis & {
  ResizeObserver?: typeof ResizeObserver;
  Worker?: typeof Worker;
};
reactActEnvironment.ResizeObserver ??= class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};
HTMLElement.prototype.scrollBy ??= function scrollBy() {};
HTMLElement.prototype.scrollTo ??= function scrollTo() {};
class StubWorker extends EventTarget {
  constructor(_scriptURL: string | URL, _options?: WorkerOptions) {
    super();
  }
  onerror = null;
  onmessage = null;
  postMessage() {}
  terminate() {}
}
reactActEnvironment.Worker ??= StubWorker as unknown as typeof Worker;

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: createMemoryStorage(),
});
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: createMemoryStorage(),
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const pullRequestSource = {
  description: '## Intent\n\nShip **review** context.',
  number: 12,
  provider: 'github',
  title: 'Local shared review host',
  type: 'pull-request',
  url: 'https://github.com/nkzw-tech/codiff/pull/12',
} satisfies Extract<ReviewSource, { type: 'pull-request' }>;

const repositoryState = {
  branch: 'feature/local-host',
  files: [createChangedFile('src/app.ts')],
  generatedAt: 1,
  launchPath: '/repo',
  root: '/repo',
  source: pullRequestSource,
} satisfies RepositoryState;

const createCodiffMock = (overrides: Partial<Window['codiff']> = {}): Window['codiff'] => ({
  askReviewAssistant: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  completePlan: vi.fn(async () => {}),
  createWalkthroughCommit: vi.fn(async () => ({
    hash: '0000000000000000000000000000000000000000',
    status: 'committed' as const,
  })),
  decreaseCodeFontSize: vi.fn(async () => {}),
  getAgentSkillStatus: vi.fn(async () => ({
    installed: true,
    path: '/Users/reviewer/.codex/skills/codiff',
  })),
  getConfig: vi.fn(async () => createDefaultConfig()),
  getDiffImageContent: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  getDiffSectionContent: vi.fn(async () => {
    throw new Error('Unexpected diff section load.');
  }),
  getFeatureFlags: vi.fn(async () => ({
    planSharing: false,
    walkthroughSharing: false,
  })),
  getGitIdentity: vi.fn(async () => ({
    email: 'reviewer@example.com',
    name: 'Reviewer',
  })),
  getLaunchOptions: vi.fn(async () => ({
    repositoryPathProvided: true,
    walkthrough: false,
  })),
  getMarkdownDocument: vi.fn(async ({ kind, path }) => ({
    content: '# Plan\n',
    id: `${kind}:${path}`,
    kind,
    path,
    version: 'version',
  })),
  getNarrativeWalkthrough: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  getPlanReview: vi.fn(async () => null),
  getPreferences: vi.fn(async () => ({
    agentBackend: 'codex' as const,
    claudeModel: defaultSettings.claudeModel,
    codeFontFamily: defaultSettings.codeFontFamily,
    codeFontSize: defaultSettings.codeFontSize,
    copyCommentsOnClose: true,
    diffStyle: 'split' as const,
    editorCommand: '',
    lastRepositoryPath: '/repo',
    openAIModel: defaultSettings.openAIModel,
    opencodeModel: defaultSettings.opencodeModel,
    piModel: defaultSettings.piModel,
    reviewCommentsPrefix: defaultSettings.reviewCommentsPrefix,
    showOutdated: false,
    showWhitespace: false,
    theme: 'system' as const,
    walkthroughPrompt: defaultSettings.walkthroughPrompt,
    wordWrap: false,
  })),
  getRepositoryHistory: vi.fn(async () => ({
    entries: [
      {
        author: 'Author',
        committedAt: Date.parse('2026-07-01T00:00:00.000Z'),
        parents: ['parent'],
        ref: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        scope: 'pull-request' as const,
        subject: 'PR commit',
      },
      {
        author: 'Base Author',
        committedAt: Date.parse('2026-06-01T00:00:00.000Z'),
        parents: [],
        ref: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        scope: 'base' as const,
        subject: 'Base commit',
      },
    ],
    root: '/repo',
  })),
  getRepositoryState: vi.fn(async () => repositoryState),
  getTerminalHelperStatus: vi.fn(async () => ({
    command: 'codiff',
    installed: true,
    path: '/usr/local/bin/codiff',
  })),
  increaseCodeFontSize: vi.fn(async () => {}),
  installAgentSkill: vi.fn(async () => ({
    installed: true,
    path: '/Users/reviewer/.codex/skills/codiff',
  })),
  installTerminalHelper: vi.fn(async () => ({
    command: 'codiff',
    installed: true,
    path: '/usr/local/bin/codiff',
  })),
  isWindowFullScreen: vi.fn(async () => false),
  markPlanReady: vi.fn(async () => {}),
  onConfigChanged: vi.fn(() => () => {}),
  onCopyPendingCommentsRequest: vi.fn(() => () => {}),
  onFindInDiffs: vi.fn(() => () => {}),
  onMarkdownDocumentChanged: vi.fn(() => () => {}),
  onPlanCloseRequested: vi.fn(() => () => {}),
  onRefreshRequest: vi.fn(() => () => {}),
  onRepositoryChanged: vi.fn(() => () => {}),
  onWalkthroughCommitOutput: vi.fn(() => () => {}),
  onWalkthroughProgress: vi.fn(() => () => {}),
  onWindowFullScreenChanged: vi.fn(() => () => {}),
  openConfigFile: vi.fn(async () => {}),
  openFile: vi.fn(async () => {}),
  resetCodeFontSize: vi.fn(async () => {}),
  saveMarkdownDocument: vi.fn(async (request) => ({
    document: {
      content: request.content,
      id: `${request.kind}:${request.path}`,
      kind: request.kind,
      path: request.path,
      version: 'next-version',
    },
    status: 'saved' as const,
  })),
  savePlanReview: vi.fn(async (review) => review),
  setDiffStyle: vi.fn(async () => {}),
  setShowOutdated: vi.fn(async () => {}),
  setWordWrap: vi.fn(async () => {}),
  sharePlan: vi.fn(async () => ({
    status: 'uploaded' as const,
    url: 'https://codiff.dev/p/test',
  })),
  shareWalkthrough: vi.fn(async () => ({
    status: 'uploaded' as const,
    url: 'https://codiff.dev/w/test',
  })),
  showInFolder: vi.fn(async () => {}),
  submitPullRequestComment: vi.fn(async () => {
    throw new Error('Unexpected pull request comment submit.');
  }),
  submitPullRequestReview: vi.fn(async () => {}),
  updateWalkthroughCommitMessage: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
  ...overrides,
});

test('shouldUseLocalMergeRequestHost only matches pull-request sources', () => {
  expect(shouldUseLocalMergeRequestHost(pullRequestSource)).toBe(true);
  expect(shouldUseLocalMergeRequestHost({ type: 'working-tree' })).toBe(false);
  expect(shouldUseLocalMergeRequestHost({ ref: 'abc', type: 'commit' })).toBe(false);
  expect(shouldUseLocalMergeRequestHost(null)).toBe(false);
});

test('App mounts the shared merge-request review shell for pull-request sources', async () => {
  window.codiff = createCodiffMock();
  const app = await renderReact(<App />);

  try {
    await waitFor(() => {
      expect(app.container.querySelector('.merge-request-shell')).not.toBeNull();
    });

    expect(app.container.querySelector('.merge-request-home-button')).not.toBeNull();
    expect(app.container.querySelector('.review-top-bar-source')?.textContent).toContain('PR #12');
    expect(app.container.querySelector('.codiff-source-description-header')).not.toBeNull();
    expect(app.container.querySelector('.source-description-markdown')?.textContent).toContain(
      'Ship review context.',
    );
    // Shared chrome uses Comments instead of the local History sidebar mode.
    expect(
      Array.from(app.container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent),
    ).toEqual(expect.arrayContaining(['Walkthrough', 'Tree', 'Comments']));
    expect(window.codiff.getRepositoryHistory).toHaveBeenCalled();
  } finally {
    await app.cleanup();
  }
});

test('LocalMergeRequestReviewHost generates whole-diff walkthroughs through local IPC', async () => {
  const walkthrough = {
    agent: 'codex',
    chapters: [],
    focus: 'Focus.',
    generatedAt: '2026-07-01T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'feature/local-host', root: '/repo' },
    source: pullRequestSource,
    support: [],
    title: 'Generated',
    version: 4,
  } satisfies NarrativeWalkthrough;

  const getNarrativeWalkthrough = vi.fn(async () => ({
    status: 'ready' as const,
    walkthrough,
  }));

  window.codiff = createCodiffMock({ getNarrativeWalkthrough });

  const onHome = vi.fn();
  const app = await renderReact(
    <LocalMergeRequestReviewHost
      initialMode="walkthrough"
      onHome={onHome}
      state={repositoryState}
    />,
  );

  try {
    await waitFor(() => {
      expect(getNarrativeWalkthrough).toHaveBeenCalledWith(pullRequestSource, {});
    });
    await waitFor(() => {
      // Empty-chapter walkthroughs still mark the surface ready.
      expect(app.container.textContent).toContain('This walkthrough has no readable sequence.');
    });

    await act(async () => {
      app.container.querySelector<HTMLButtonElement>('.merge-request-home-button')?.click();
    });
    expect(onHome).toHaveBeenCalledTimes(1);
  } finally {
    await app.cleanup();
  }
});

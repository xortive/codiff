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
  generateReviewWalkthrough: vi.fn(async () => ({
    reason: 'Unavailable in tests.',
    status: 'unavailable' as const,
  })),
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
  getGitLabReviewVersionCompare: vi.fn(async () => {
    throw new Error('Unexpected GitLab version compare.');
  }),
  getGitLabReviewVersions: vi.fn(async () => []),
  getGitLabReviewVersionUnitDiff: vi.fn(async () => []),
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
  getReviewVersionCompare: vi.fn(async () => {
    throw new Error('Unexpected review version compare.');
  }),
  getReviewVersions: vi.fn(async () => ({ versions: [], warning: null })),
  getReviewVersionUnitDiff: vi.fn(async () => []),
  getStoredReviewWalkthrough: vi.fn(async () => ({ status: 'missing' as const })),
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

test('LocalMergeRequestReviewHost generates whole-diff walkthroughs through shared orchestration IPC', async () => {
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

  const generateReviewWalkthrough = vi.fn(async () => ({
    status: 'ready' as const,
    walkthrough,
  }));

  window.codiff = createCodiffMock({ generateReviewWalkthrough });

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
      expect(generateReviewWalkthrough).toHaveBeenCalled();
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

test('walkthrough generation shows its structure and queues an override', async () => {
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
  let resolveFirst:
    | ((result: { status: 'ready'; walkthrough: NarrativeWalkthrough }) => void)
    | null = null;
  const firstGeneration = new Promise<{ status: 'ready'; walkthrough: NarrativeWalkthrough }>(
    (resolve) => {
      resolveFirst = resolve;
    },
  );
  const generateReviewWalkthrough = vi
    .fn()
    .mockImplementationOnce(() => firstGeneration)
    .mockResolvedValue({ status: 'ready' as const, walkthrough });
  window.codiff = createCodiffMock({ generateReviewWalkthrough });

  const app = await renderReact(
    <LocalMergeRequestReviewHost
      initialMode="walkthrough"
      onHome={() => {}}
      state={repositoryState}
    />,
  );

  try {
    await waitFor(() => {
      expect(app.container.textContent).toContain('Generating · Whole PR');
    });
    const switchButton = Array.from(app.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Switch to commit-by-commit'),
    );
    expect(switchButton).not.toBeUndefined();
    await act(async () => {
      switchButton?.click();
    });
    expect(app.container.textContent).toContain('Queued: commit-by-commit');

    await act(async () => {
      resolveFirst?.({ status: 'ready', walkthrough });
      await firstGeneration;
    });
    await waitFor(() => {
      expect(generateReviewWalkthrough).toHaveBeenCalledTimes(2);
    });
    expect(generateReviewWalkthrough.mock.calls[1]?.[0]).toMatchObject({
      force: true,
      structure: 'units',
    });
  } finally {
    await app.cleanup();
  }
});

test('GitLab sources load review versions through IPC into the shared host', async () => {
  const gitlabSource = {
    description: '## Intent\n\nShip **MR** versions.',
    host: 'gitlab.example.com',
    number: 13,
    projectPath: 'group/project',
    provider: 'gitlab',
    title: 'Local GitLab history',
    type: 'pull-request',
    url: 'https://gitlab.example.com/group/project/-/merge_requests/13',
  } satisfies Extract<ReviewSource, { type: 'pull-request' }>;

  const versionOption = {
    createdAt: '2026-01-02T00:00:00.000Z',
    id: '2',
    isHead: true,
    number: 2,
    range: {
      base: {
        commitId: 'a'.repeat(40),
        label: { kind: 'commit' as const, text: 'aaaaaaa' },
      },
      head: {
        commitId: 'c'.repeat(40),
        label: { kind: 'version' as const, text: 'v2' },
      },
    },
  };
  const baseOption = {
    createdAt: '2026-01-01T00:00:00.000Z',
    id: 'mr-base',
    isHead: false,
    number: 0,
    range: {
      base: {
        commitId: 'a'.repeat(40),
        label: { kind: 'commit' as const, text: 'aaaaaaa' },
      },
      head: {
        commitId: 'a'.repeat(40),
        label: { kind: 'version' as const, text: 'MR base' },
      },
    },
  };
  const v1Option = {
    createdAt: '2026-01-01T12:00:00.000Z',
    id: '1',
    isHead: false,
    number: 1,
    range: {
      base: {
        commitId: 'a'.repeat(40),
        label: { kind: 'commit' as const, text: 'aaaaaaa' },
      },
      head: {
        commitId: 'b'.repeat(40),
        label: { kind: 'version' as const, text: 'v1' },
      },
    },
  };

  const getReviewVersions = vi.fn(async () => ({
    versions: [baseOption, v1Option, versionOption],
    warning: null,
  }));
  const getReviewVersionCompare = vi.fn(async () => ({
    versionCommitEvolution: null,
    versionCommitEvolutionError: null,
    versionCompare: {
      analysis: {
        summary: {
          addedLines: 1,
          baseMoved: false,
          commentsAffected: 0,
          conflictFiles: 0,
          deletedLines: 0,
          empty: false,
          filesChanged: 1,
          intentionalFiles: 1,
          noiseFiles: 0,
        },
      },
      comparison: {
        after: versionOption.range,
        before: v1Option.range,
      },
      files: [createChangedFile('src/app.ts')],
      from: v1Option,
      to: versionOption,
    },
    warning: null,
  }));

  window.codiff = createCodiffMock({
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      source: gitlabSource,
    })),
    getReviewVersionCompare,
    getReviewVersions,
  });

  const app = await renderReact(
    <LocalMergeRequestReviewHost
      onHome={() => {}}
      state={{
        ...repositoryState,
        source: gitlabSource,
      }}
    />,
  );

  try {
    await waitFor(() => {
      expect(getReviewVersions).toHaveBeenCalledWith({ source: gitlabSource });
    });

    await waitFor(() => {
      expect(app.container.querySelector('.merge-request-shell')).not.toBeNull();
    });

    const compareButton = Array.from(app.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Compare versions'),
    );
    expect(compareButton).not.toBeUndefined();

    await act(async () => {
      compareButton?.click();
    });

    await waitFor(() => {
      expect(getReviewVersionCompare).toHaveBeenCalledWith({
        fromId: '1',
        source: gitlabSource,
        toId: '2',
      });
    });
  } finally {
    await app.cleanup();
  }
});

test('GitHub sources load head history and use Compare heads copy', async () => {
  const githubSource = {
    description: '## Intent\n\nShip **PR** heads.',
    number: 12,
    owner: 'nkzw-tech',
    provider: 'github',
    repo: 'codiff',
    title: 'Local GitHub history',
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/12',
  } satisfies Extract<ReviewSource, { type: 'pull-request' }>;

  const headA = {
    createdAt: '2026-01-01T00:00:00.000Z',
    id: 'a'.repeat(40),
    isHead: false,
    number: 1,
    range: {
      base: {
        commitId: '0'.repeat(40),
        label: { kind: 'commit' as const, text: '0000000' },
      },
      head: {
        commitId: 'a'.repeat(40),
        label: { kind: 'version' as const, text: 'Head · aaaaaaa' },
      },
    },
  };
  const headB = {
    createdAt: '2026-01-02T00:00:00.000Z',
    id: 'b'.repeat(40),
    isHead: true,
    number: 2,
    range: {
      base: {
        commitId: '0'.repeat(40),
        label: { kind: 'commit' as const, text: '0000000' },
      },
      head: {
        commitId: 'b'.repeat(40),
        label: { kind: 'version' as const, text: 'Current head' },
      },
    },
  };

  const getReviewVersions = vi.fn(async () => ({
    versions: [headA, headB],
    warning: null,
  }));
  const unit = {
    after: {
      authoredAt: '2026-01-02T00:00:00.000Z',
      authorName: 'Author',
      parentIds: [headA.id],
      sha: headB.id,
      shortSha: headB.id.slice(0, 7),
      subject: 'Update the implementation',
    },
    confidence: 'exact' as const,
    id: `introduced:${headB.id}`,
    kind: 'introduced' as const,
    order: 0,
    reviewable: true as const,
  };
  const getReviewVersionCompare = vi.fn(async () => ({
    versionCommitEvolution: {
      recommendation: {
        rationale: 'Review the changed commit.',
        suggestedStructure: 'commit-by-commit' as const,
      },
      summary: {
        absorbedIntoBase: 0,
        added: 1,
        ambiguous: 0,
        pairingCoverage: 1,
        removed: 0,
        retained: 0,
        reviewable: 1,
        revised: 0,
        rewrittenSamePatch: 0,
      },
      units: [unit],
    },
    versionCommitEvolutionError: null,
    versionCompare: {
      analysis: {
        summary: {
          addedLines: 1,
          baseMoved: false,
          commentsAffected: 0,
          conflictFiles: 0,
          deletedLines: 0,
          empty: false,
          filesChanged: 1,
          intentionalFiles: 1,
          noiseFiles: 0,
        },
      },
      comparison: {
        after: headB.range,
        before: headA.range,
      },
      files: [createChangedFile('src/app.ts')],
      from: headA,
      to: headB,
    },
    warning: null,
  }));
  const getReviewVersionUnitDiff = vi.fn(async () => [createChangedFile('src/unit.ts')]);

  window.codiff = createCodiffMock({
    getRepositoryState: vi.fn(async () => ({
      ...repositoryState,
      source: githubSource,
    })),
    getReviewVersionCompare,
    getReviewVersions,
    getReviewVersionUnitDiff,
  });

  const app = await renderReact(
    <LocalMergeRequestReviewHost
      onHome={() => {}}
      state={{
        ...repositoryState,
        source: githubSource,
      }}
    />,
  );

  try {
    await waitFor(() => {
      expect(getReviewVersions).toHaveBeenCalledWith({ source: githubSource });
    });
    await waitFor(() => {
      expect(app.container.textContent).toContain('Whole PR');
    });
    const compareButton = Array.from(app.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Compare heads'),
    );
    expect(compareButton).not.toBeUndefined();
    await act(async () => {
      compareButton?.click();
    });
    await waitFor(() => {
      expect(getReviewVersionCompare).toHaveBeenCalledWith({
        fromId: headA.id,
        source: githubSource,
        toId: headB.id,
      });
    });
    let unitButton: HTMLButtonElement | null = null;
    await waitFor(() => {
      unitButton = app.container.querySelector<HTMLButtonElement>(
        '.version-commit-unit.introduced',
      );
      expect(unitButton).not.toBeNull();
    });
    await act(async () => {
      unitButton?.click();
    });
    await waitFor(() => {
      expect(getReviewVersionUnitDiff).toHaveBeenCalledWith({
        source: githubSource,
        unit,
      });
    });
  } finally {
    await app.cleanup();
  }
});

test('history warnings remain baseline status instead of activating comparison mode', async () => {
  window.codiff = createCodiffMock({
    getReviewVersions: vi.fn(async () => ({
      versions: [],
      warning: 'Force-push timeline unavailable. Showing current head only.',
    })),
  });
  const app = await renderReact(
    <LocalMergeRequestReviewHost onHome={() => {}} state={repositoryState} />,
  );

  try {
    await waitFor(() => {
      expect(app.container.textContent).toContain('Force-push timeline unavailable');
    });
    const wholeButton = Array.from(app.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Whole PR'),
    );
    expect(wholeButton?.getAttribute('aria-pressed')).toBe('true');
    expect(app.container.querySelector('#version-comparison-body')).toBeNull();
  } finally {
    await app.cleanup();
  }
});

test('manual refresh reloads review data and updates the freshness label', async () => {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const refreshedAt = Date.now();
  const getRepositoryState = vi.fn(async () => ({
    ...repositoryState,
    generatedAt: refreshedAt,
  }));
  window.codiff = createCodiffMock({ getRepositoryState });
  const app = await renderReact(
    <LocalMergeRequestReviewHost
      onHome={() => {}}
      state={{ ...repositoryState, generatedAt: sevenDaysAgo }}
    />,
  );

  try {
    let refreshButton: HTMLButtonElement | undefined;
    await waitFor(() => {
      refreshButton = Array.from(app.container.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.includes('Refresh PR · updated 7d ago'),
      );
      expect(refreshButton).not.toBeUndefined();
    });
    await act(async () => {
      refreshButton?.click();
    });
    await waitFor(() => {
      expect(getRepositoryState).toHaveBeenCalledWith(pullRequestSource);
      expect(app.container.textContent).toContain('Refresh PR · updated just now');
    });
  } finally {
    await app.cleanup();
  }
});

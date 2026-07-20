import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDefaultConfig } from '../config/defaults.ts';
import type { CodiffConfig } from '../config/types.ts';
import { sortFiles } from '../lib/files.ts';
import { getSourceLabel } from '../lib/source.ts';
import {
  MergeRequestReviewApp,
  type MergeRequestCommitListEntry,
  type MergeRequestReviewMode,
  type MergeRequestWalkthroughStatus,
} from '../SharedWalkthroughApp.tsx';
import type {
  ChangedFile,
  CodiffPreferences,
  GitIdentity,
  HistoryEntry,
  NarrativeWalkthrough,
  PullRequestExistingReviewComment,
  PullRequestReviewComment,
  PullRequestReviewEvent,
  RepositoryState,
  ReviewSource,
} from '../types.ts';

const getPreferencesFromConfig = ({ settings }: CodiffConfig): CodiffPreferences => ({
  ...settings,
});

const defaultPreferences = getPreferencesFromConfig(createDefaultConfig());

const toCommitListEntries = (
  entries: ReadonlyArray<HistoryEntry>,
): ReadonlyArray<MergeRequestCommitListEntry> =>
  entries
    .filter((entry) => entry.scope !== 'base')
    .map((entry) => ({
      authoredAt: new Date(entry.committedAt).toISOString(),
      authorName: entry.author,
      sha: entry.ref,
      shortSha: entry.ref.slice(0, 7),
      subject: entry.subject,
    }));

const getPullRequestTitle = (state: RepositoryState) => {
  if (state.source.type !== 'pull-request') {
    return 'Review';
  }
  return state.source.title?.trim() || getSourceLabel(state.source);
};

const getSourceIdentityKey = (source: ReviewSource) =>
  source.type === 'pull-request'
    ? `pull-request:${source.provider ?? ''}:${source.url}`
    : `${source.type}`;

const sortRepositoryState = (state: RepositoryState): RepositoryState => ({
  ...state,
  files: sortFiles(state.files),
});

const unsupportedGeneralComment = async (): Promise<void> => {
  throw new Error('General discussion comments are not supported in local Codiff yet.');
};

const unsupportedCommentUpdate = async (): Promise<void> => {
  throw new Error('Editing submitted review comments is not supported in local Codiff yet.');
};

export type LocalMergeRequestReviewHostProps = {
  gitIdentity?: GitIdentity | null;
  initialMode?: MergeRequestReviewMode;
  onHome: () => void;
  preferences?: Partial<
    Pick<
      CodiffPreferences,
      'codeFontFamily' | 'codeFontSize' | 'diffStyle' | 'showWhitespace' | 'theme' | 'wordWrap'
    >
  >;
  /** Preloaded snapshot handed off from App bootstrap. */
  state: RepositoryState;
};

type HostSessionProps = LocalMergeRequestReviewHostProps & {
  sourceKey: string;
};

/**
 * One session per PR/MR identity. App remounts this when the source key changes
 * so we avoid setState-in-effect reset patterns.
 */
function LocalMergeRequestReviewSession({
  gitIdentity = null,
  initialMode,
  onHome,
  preferences: preferencesProp,
  state: initialState,
}: HostSessionProps) {
  const [liveState, setLiveState] = useState<RepositoryState | null>(null);
  const state = liveState ?? sortRepositoryState(initialState);
  const stateRef = useRef(state);
  const [commits, setCommits] = useState<ReadonlyArray<MergeRequestCommitListEntry>>([]);
  const [walkthrough, setWalkthrough] = useState<NarrativeWalkthrough | null>(null);
  const [walkthroughStatus, setWalkthroughStatus] =
    useState<MergeRequestWalkthroughStatus>('idle');
  const [walkthroughError, setWalkthroughError] = useState<string | null>(null);
  const [configPreferences, setConfigPreferences] = useState(defaultPreferences);
  const [mode, setMode] = useState<MergeRequestReviewMode | undefined>(initialMode);
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(null);
  const commitDiffCacheRef = useRef<Map<string, ReadonlyArray<ChangedFile>>>(new Map());
  const walkthroughRequestRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let canceled = false;
    window.codiff.getConfig().then(
      (config) => {
        if (!canceled) {
          setConfigPreferences(getPreferencesFromConfig(config));
        }
      },
      () => {},
    );
    const unsubscribe = window.codiff.onConfigChanged((config) => {
      setConfigPreferences(getPreferencesFromConfig(config));
    });
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (state.source.type !== 'pull-request') {
      return;
    }

    let canceled = false;
    const source = state.source;

    const loadCommits = async () => {
      const history = await window.codiff.getRepositoryHistory(200, source);
      if (canceled) {
        return;
      }
      setCommits(toCommitListEntries(history.entries));
    };

    loadCommits().catch(() => {
      if (!canceled) {
        setCommits([]);
      }
    });

    return () => {
      canceled = true;
    };
  }, [state.source]);

  const refreshState = useCallback(async () => {
    const current = stateRef.current;
    if (current.source.type !== 'pull-request') {
      return;
    }
    const nextState = await window.codiff.getRepositoryState(current.source);
    const ordered = sortRepositoryState(nextState);
    stateRef.current = ordered;
    setLiveState(ordered);
    commitDiffCacheRef.current.clear();
    setSelectedCommitSha(null);
  }, []);

  useEffect(() => window.codiff.onRefreshRequest(() => void refreshState()), [refreshState]);

  const onSubmitComment = useCallback(
    async (comment: PullRequestReviewComment): Promise<PullRequestExistingReviewComment> => {
      const current = stateRef.current;
      if (current.source.type !== 'pull-request') {
        throw new Error('Review comments require a pull request source.');
      }
      const submitted = await window.codiff.submitPullRequestComment({
        comment,
        source: current.source,
      });
      await refreshState();
      return submitted;
    },
    [refreshState],
  );

  const onSubmitReview = useCallback(
    async (
      event: PullRequestReviewEvent,
      comments: ReadonlyArray<PullRequestReviewComment>,
      body?: string,
    ) => {
      const current = stateRef.current;
      if (current.source.type !== 'pull-request') {
        throw new Error('Reviews require a pull request source.');
      }
      await window.codiff.submitPullRequestReview({
        ...(body ? { body } : {}),
        comments,
        event,
        source: current.source,
      });
      await refreshState();
    },
    [refreshState],
  );

  const onSubmitGeneralComment = useCallback(async (_body: string) => {
    await unsupportedGeneralComment();
  }, []);

  const onUpdateComment = useCallback(async (_commentId: string, _body: string) => {
    await unsupportedCommentUpdate();
  }, []);

  const onUpdateGeneralComment = useCallback(async (_commentId: string, _body: string) => {
    await unsupportedCommentUpdate();
  }, []);

  const onLoadCommitDiff = useCallback(async (sha: string) => {
    const cached = commitDiffCacheRef.current.get(sha);
    if (cached) {
      setSelectedCommitSha(sha);
      return cached;
    }
    const commitState = await window.codiff.getRepositoryState({
      ref: sha,
      type: 'commit',
    } satisfies ReviewSource);
    const files = sortFiles(commitState.files);
    commitDiffCacheRef.current.set(sha, files);
    setSelectedCommitSha(sha);
    return files;
  }, []);

  const onGenerateWalkthrough = useCallback(
    async (options?: {
      force?: boolean;
      reviewStructure?: 'commit-by-commit' | 'whole-diff';
      unitId?: string;
      versionCompare?: {
        fromId: string;
        toId: string;
        walkthroughStructure?: 'auto' | 'commit-by-commit' | 'whole-diff';
      };
    }) => {
      const current = stateRef.current;
      if (current.source.type !== 'pull-request') {
        return;
      }
      // Version-scoped / unit generation lands with history wiring; baseline whole-diff only.
      if (options?.versionCompare || options?.unitId) {
        setWalkthroughStatus('failed');
        setWalkthroughError(
          'Version compare and unit walkthroughs are not wired in local Codiff yet.',
        );
        return;
      }
      if (current.files.length === 0) {
        setWalkthrough(null);
        setWalkthroughStatus('idle');
        setWalkthroughError(null);
        return;
      }

      const requestId = ++walkthroughRequestRef.current;
      setWalkthroughStatus('generating');
      setWalkthroughError(null);
      try {
        const result = await window.codiff.getNarrativeWalkthrough(
          current.source,
          options?.force ? { force: true } : {},
        );
        if (requestId !== walkthroughRequestRef.current) {
          return;
        }
        if (result.status === 'ready') {
          setWalkthrough(result.walkthrough);
          setWalkthroughStatus('ready');
          setWalkthroughError(null);
          return;
        }
        setWalkthrough(null);
        setWalkthroughStatus('failed');
        setWalkthroughError(result.reason);
      } catch (error: unknown) {
        if (requestId !== walkthroughRequestRef.current) {
          return;
        }
        setWalkthrough(null);
        setWalkthroughStatus('failed');
        setWalkthroughError(error instanceof Error ? error.message : String(error));
      }
    },
    [],
  );

  const title = useMemo(() => getPullRequestTitle(state), [state]);
  const externalUrl = state.source.type === 'pull-request' ? state.source.url : '';

  const resolvedPreferences = useMemo(
    () => ({
      codeFontFamily: preferencesProp?.codeFontFamily ?? configPreferences.codeFontFamily,
      codeFontSize: preferencesProp?.codeFontSize ?? configPreferences.codeFontSize,
      diffStyle: preferencesProp?.diffStyle ?? configPreferences.diffStyle,
      showWhitespace: preferencesProp?.showWhitespace ?? configPreferences.showWhitespace,
      theme: preferencesProp?.theme ?? configPreferences.theme,
      wordWrap: preferencesProp?.wordWrap ?? configPreferences.wordWrap,
    }),
    [configPreferences, preferencesProp],
  );

  if (state.source.type !== 'pull-request') {
    return null;
  }

  return (
    <MergeRequestReviewApp
      commits={commits}
      externalUrl={externalUrl}
      gitIdentity={gitIdentity}
      initialMode={mode}
      onExitVersionCompare={() => {
        // History wiring lands in a later plan step.
      }}
      onGenerateWalkthrough={onGenerateWalkthrough}
      onHome={onHome}
      onLoadCommitDiff={onLoadCommitDiff}
      onModeChange={setMode}
      onOpenVersionCompare={() => {
        // History wiring lands in a later plan step.
      }}
      onSubmitComment={onSubmitComment}
      onSubmitGeneralComment={onSubmitGeneralComment}
      onSubmitReview={onSubmitReview}
      onUpdateComment={onUpdateComment}
      onUpdateGeneralComment={onUpdateGeneralComment}
      onVersionCompareRangeChange={() => {
        // History wiring lands in a later plan step.
      }}
      preferences={resolvedPreferences}
      selectedCommitSha={selectedCommitSha}
      state={state}
      title={title}
      versionHistoryLoading={false}
      versions={[]}
      walkthrough={walkthrough}
      walkthroughError={walkthroughError}
      walkthroughStatus={walkthroughStatus}
    />
  );
}

/**
 * Desktop host adapter for pull-request / merge-request sources.
 * Feeds Core `MergeRequestReviewApp` with local IPC-backed data and actions.
 * Version compare / evolution props stay empty until later plan steps.
 */
export function LocalMergeRequestReviewHost(props: LocalMergeRequestReviewHostProps) {
  const sourceKey = getSourceIdentityKey(props.state.source);
  return <LocalMergeRequestReviewSession key={sourceKey} {...props} sourceKey={sourceKey} />;
}

export function shouldUseLocalMergeRequestHost(source: ReviewSource | null | undefined): boolean {
  return source?.type === 'pull-request';
}

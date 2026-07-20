import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { evolutionUnitCommit } from '../../lib/review-history.ts';
import type {
  MergeRequestCommitListEntry,
  MergeRequestVersionCommitEvolution,
  MergeRequestVersionCommitEvolutionUnit,
} from '../../SharedWalkthroughApp.tsx';
import { CommitRefTooltip } from './CommitRefTooltip.tsx';

export type CommitScopePanelProps = {
  commits: ReadonlyArray<MergeRequestCommitListEntry>;
  mode: 'merge-request' | 'version-compare';
  onClear: () => void;
  onSelectCommit: (sha: string | null) => void;
  onToggleVersionUnit?: (unit: MergeRequestVersionCommitEvolutionUnit) => void;
  selectedCommitShas?: ReadonlySet<string>;
  selectedVersionUnitIds?: ReadonlySet<string>;
  versionCommitEvolution?: MergeRequestVersionCommitEvolution | null;
  versionUnitError?: string | null;
  versionUnitLoading?: boolean;
};

export function CommitScopePanel({
  commits,
  mode,
  onClear,
  onSelectCommit,
  onToggleVersionUnit,
  selectedCommitShas = new Set(),
  selectedVersionUnitIds = new Set(),
  versionCommitEvolution,
  versionUnitError,
  versionUnitLoading = false,
}: CommitScopePanelProps) {
  const [expanded, setExpanded] = useState(true);
  const selectedUnits =
    versionCommitEvolution?.units.filter((unit) => selectedVersionUnitIds.has(unit.id)) ?? [];
  const summary =
    mode === 'merge-request'
      ? selectedCommitShas.size > 0
        ? `${selectedCommitShas.size} selected commit${selectedCommitShas.size === 1 ? '' : 's'}`
        : 'All merge request changes'
      : selectedUnits.length > 0
        ? `${selectedUnits.length} selected commit${selectedUnits.length === 1 ? '' : 's'}`
        : 'All version changes';

  return (
    <section className="version-tree-commit-scope">
      <div className="version-tree-commit-scope-header">
        <button
          aria-expanded={expanded}
          className="commit-scope-heading"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <span className="commit-scope-heading-label">
            <ChevronDown aria-hidden className={expanded ? '' : 'collapsed'} size={14} />
            <span>Commit scope</span>
          </span>
          <small>{summary}</small>
        </button>
        <button
          aria-label="Show all changes"
          className="merge-request-nav-button"
          disabled={
            mode === 'merge-request' ? selectedCommitShas.size === 0 : selectedUnits.length === 0
          }
          onClick={onClear}
          title="Show all changes"
          type="button"
        >
          All
        </button>
      </div>
      {expanded ? (
        <div className="version-tree-commit-options">
          {mode === 'merge-request' ? (
            <>
              {commits.map((commit) => (
                <label
                  key={commit.sha}
                  onClick={(event) => {
                    if (event.target instanceof HTMLElement && event.target.closest('a')) {
                      return;
                    }
                    event.preventDefault();
                    onSelectCommit(commit.sha);
                  }}
                >
                  <input checked={selectedCommitShas.has(commit.sha)} readOnly type="checkbox" />
                  <CommitRefTooltip
                    commit={{
                      authoredAt: commit.authoredAt,
                      authorName: commit.authorName,
                      sha: commit.sha,
                      shortSha: commit.shortSha,
                      subject: commit.subject,
                      webUrl: commit.webUrl,
                    }}
                    focusable={false}
                    linkTrigger={false}
                  />
                  <span>{commit.subject}</span>
                </label>
              ))}
            </>
          ) : (
            versionCommitEvolution?.units
              .filter((unit) => unit.reviewable)
              .map((unit) => {
                const commit = evolutionUnitCommit(unit);
                if (!commit || !onToggleVersionUnit) {
                  return null;
                }
                return (
                  <label
                    key={unit.id}
                    onClick={(event) => {
                      if (event.target instanceof HTMLElement && event.target.closest('a')) {
                        return;
                      }
                      event.preventDefault();
                      onToggleVersionUnit(unit);
                    }}
                  >
                    <input checked={selectedVersionUnitIds.has(unit.id)} readOnly type="checkbox" />
                    <CommitRefTooltip
                      commit={{
                        additions: commit.diffStat?.additions,
                        authoredAt: commit.authoredAt,
                        authorName: commit.authorName,
                        deletions: commit.diffStat?.deletions,
                        sha: commit.sha,
                        shortSha: commit.shortSha,
                        subject: commit.subject,
                        webUrl: commit.webUrl,
                      }}
                      focusable={false}
                      linkTrigger={false}
                    />
                    <span>{commit.subject}</span>
                  </label>
                );
              })
          )}
          {versionUnitLoading ? (
            <div className="sidebar-scope-status">Loading selected commit changes…</div>
          ) : null}
          {versionUnitError ? (
            <div className="sidebar-scope-status error">{versionUnitError}</div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

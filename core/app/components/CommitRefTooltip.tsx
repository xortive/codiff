import { Tooltip } from '@base-ui/react/tooltip';
import { ExternalLink } from 'lucide-react';

export type CommitRefSummary = {
  additions?: number;
  authoredAt?: number | string | null;
  authorName?: string;
  deletions?: number;
  sha: string;
  shortSha: string;
  subject?: string;
  webUrl?: string;
};

export function CommitRefTooltip({
  className,
  commit,
  focusable = true,
  linkTrigger = true,
}: {
  className?: string;
  commit: CommitRefSummary;
  focusable?: boolean;
  linkTrigger?: boolean;
}) {
  const triggerClassName = ['git-commit-ref-trigger', className].filter(Boolean).join(' ');
  const trigger =
    linkTrigger && commit.webUrl ? (
      <a
        className={triggerClassName}
        href={commit.webUrl}
        rel="noreferrer"
        target="_blank"
      />
    ) : (
      <span className={triggerClassName} tabIndex={focusable ? 0 : -1} />
    );
  const authoredAt = commit.authoredAt ? new Date(commit.authoredAt) : null;
  const authoredLabel =
    authoredAt && Number.isFinite(authoredAt.getTime()) ? authoredAt.toLocaleString() : null;

  return (
    <Tooltip.Root disableHoverablePopup={false}>
      <Tooltip.Trigger closeDelay={120} delay={250} render={trigger}>
        <code>{commit.shortSha}</code>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner className="git-commit-tooltip-positioner" sideOffset={6}>
          <Tooltip.Popup className="git-commit-tooltip">
            <strong>{commit.subject || 'Commit'}</strong>
            <code className="git-commit-tooltip-sha">{commit.sha}</code>
            {commit.authorName || authoredLabel ? (
              <span className="git-commit-tooltip-meta">
                {[commit.authorName, authoredLabel].filter(Boolean).join(' · ')}
              </span>
            ) : null}
            {commit.additions != null || commit.deletions != null ? (
              <span className="git-commit-tooltip-diffstat">
                {commit.additions != null ? (
                  <span className="diffstat-additions">+{commit.additions}</span>
                ) : null}
                {commit.deletions != null ? (
                  <span className="diffstat-deletions">−{commit.deletions}</span>
                ) : null}
              </span>
            ) : null}
            {commit.webUrl ? (
              <a
                className="git-commit-tooltip-link"
                href={commit.webUrl}
                rel="noreferrer"
                target="_blank"
              >
                View commit in GitLab
                <ExternalLink aria-hidden size={12} />
              </a>
            ) : null}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

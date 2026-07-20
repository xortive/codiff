# Local Codiff App Review

The patch produces incorrect or unusable GitHub history comparisons in the local Codiff app.

Full review comments:

- [P1] Use a head-to-head diff for force-push comparisons — `github/src/history.ts:617-623`
  When force-pushed heads diverge, `readRangeFiles(..., true)` resolves the old endpoint to the merge base, so this shows the entire base-to-new-head PR diff instead of changes between the two heads. Even a pure history rewrite with an unchanged tree appears as the whole PR rather than an empty version delta.

- [P2] Keep history warnings out of comparison state — `core/app/LocalMergeRequestReviewHost.tsx:616-617`
  When history loading returns a warning, such as GitHub timeline permissions being unavailable, passing it as `versionCompareError` makes `versionCompareActive` true despite no comparison being selected. The UI becomes stuck in compare mode because exiting still re-injects the same `historyWarning`; surface this warning separately until a comparison is opened.

- [P2] Route GitHub unit diffs through the generic IPC — `core/app/LocalMergeRequestReviewHost.tsx:332-339`
  For GitHub comparisons this callback always returns an empty file list because it only permits GitLab and calls the legacy GitLab-specific IPC. Consequently selecting a GitHub evolution unit cannot display its changes even though `getReviewVersionUnitDiff` and `loadGitHubVersionCommitUnitDiff` were added for this purpose.

- [P2] Derive a base for each historical GitHub head — `github/src/history.ts:290-293`
  Every historical head is stamped with the current PR base SHA, so `fromBase` and `toBase` are always identical in production comparisons. If the target branch advanced between force pushes, base movement is never reported and the newly added base-movement/evolution logic cannot classify commits absorbed into the base.

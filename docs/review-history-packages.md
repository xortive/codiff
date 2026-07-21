# Review-history package notes

These packages are the Codiff-side extraction target for Codiff Web.

## Packages

| Package               | Notes                                                                            |
| --------------------- | -------------------------------------------------------------------------------- |
| `@nkzw/codiff-core`   | Review-history contracts + `walkthrough-authoring` + `generateReviewWalkthrough` |
| `@nkzw/codiff-gitlab` | Read-side GitLab history adapter over `GitLabTransport`                          |

## New Core contracts

Import from `@nkzw/codiff-core` / `@nkzw/codiff-core/types`:

- `RevisionLabel`, `RevisionRef`, `DiffRange`, `DiffComparison`
- `DiffComparisonAnalysis`, `DiffComparisonView`
- `ReviewUnit`, `ReviewEvolutionUnit`, `ReviewCommitEvolution`
- `ReviewStructureRecommendation`, `ReviewPlan`
- `WalkthroughGenerationInput`
- helpers: `resolveReviewPlan`, `reviewVersionOption`, `project`-style builders in `lib/review-history`

Shared review UI still exports compatibility aliases such as
`MergeRequestVersionOption`, but those now alias the Core contracts above.

## Walkthrough authoring

Import from `@nkzw/codiff-core/walkthrough-authoring`:

- `parseWalkthroughDraft` / `parseAuthoredWalkthrough`
- `parseRepositoryState`
- `indexWalkthroughHunks`
- `buildWalkthroughPrompt` / `buildWalkthroughPromptInput`
- `normalizeWalkthroughDraft` / `normalizeAuthoredWalkthrough`
- `attachVersionCommentReferences`
- `composeUnitWalkthroughs` / `combineCommitWalkthroughs`

This module owns draft validation, hunk aliasing, prompt construction,
normalization, and unit composition. Hosts keep model IDs, AI Gateway routing,
retries, Durable Object orchestration, and cache policy.

Generation input rule:

- whole-diff plan -> one `RepositoryState`
- units plan -> one `RepositoryState` per `ReviewUnit`

## GitLab package

Import from `@nkzw/codiff-gitlab`.

Host implements:

```ts
type GitLabTransport = {
  request<T>(request: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
    body?: unknown;
  }): Promise<T>;
  requestPages?(request: {
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
  }): Promise<Array<unknown>>;
  requestText?(request: {
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
  }): Promise<string>;
};
```

Package owns:

- endpoint construction and pagination
- version list / historical commit+diff loading
- version comparison materialization
- patch signatures, commit evolution, review-structure classification
- projection helpers: `projectVersionCompare`, `projectCommitEvolution`,
  `projectReviewPlan`, `toGitLabDiffIdentity`

Not migrated in this package extraction:

- baseline current-MR snapshot loading
- write-side comments/reviews/merge mutations
- host authentication

## Codiff Web migration checklist

1. Depend on `@nkzw/codiff-core` and `@nkzw/codiff-gitlab`.
2. Implement Worker `GitLabTransport` over `GITLAB_VPC_BRIDGE`.
3. Replace local version-compare / evolution / review-strategy copies with package APIs.
4. Replace local walkthrough draft/prompt/normalize/combine helpers with
   `@nkzw/codiff-core/walkthrough-authoring`.
5. Keep D1/R2, Durable Objects, Think/AI Gateway, and Fate orchestration in Web.
6. Feed Core `MergeRequestReviewApp` with projected Core contracts, not GitLab
   wire shapes.

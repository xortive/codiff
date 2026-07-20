# Plan: Local Codiff Review-History Parity

## Goal

Bring local Codiff to product parity with Codiff Web's review-history experience:

- pick historical review endpoints
- compare two endpoints as a review surface
- classify commit-stack evolution
- generate whole-diff or unit walkthroughs through shared authoring

Do this on top of the already-extracted packages:

- `@nkzw/codiff-core` contracts + `MergeRequestReviewApp` + `walkthrough-authoring`
- `@nkzw/codiff-gitlab` read-side GitLab adapter + `GitLabTransport`
- local `createGlabGitLabTransport`

Codiff Web remains the Cloudflare host. Local Codiff becomes the desktop host.
Both should consume the same packages and render the same Core review UI.

## Non-goals

- Web D1/R2 caches, Durable Objects, Fate live updates, Think/AI Gateway
- migrating baseline current-MR/PR loading or write-side comments/reviews yet
- full Jujutsu identity / evolution-log support
- making GitHub invent GitLab-style numbered versions

Local parity means **same review semantics and UX**, not the same cloud
orchestration stack.

## Current State

### Already shared

- Core review-history contracts (`DiffRange`, `DiffComparison`, units, plans)
- Core review UI that can render versions / compare / evolution when fed props
- Walkthrough authoring (`parse` / `prompt` / `normalize` / `compose`)
- GitLab history package over injected transport
- Local glab transport primitive
- Local whole-diff walkthrough generation routed through authoring

### Still local-only / missing

- Electron does **not** call `@nkzw/codiff-gitlab` for versions/compare/evolution
- Local PR/MR UI still primarily goes through `core/App.tsx`, not the full
  `MergeRequestReviewApp` host loop used by Web
- No local unit-walkthrough orchestration
- No GitHub force-push / head-comparison history provider
- Web still has in-tree copies of GitLab history + authoring (migration later)

## Target Architecture

```text
@nkzw/codiff-core
  contracts, MergeRequestReviewApp, walkthrough-authoring

@nkzw/codiff-gitlab
  GitLab versions / compare / evolution / unit diffs / plans
  over GitLabTransport

@nkzw/codiff-github   (new, or electron/git-state/github-history first)
  GitHub force-push heads / compare / evolution / plans
  over GitHubTransport

local Codiff host
  glab transport + gh transport
  IPC + local agent invocation
  mounts MergeRequestReviewApp for PR/MR sources

Codiff Web host
  Worker GitLabTransport (+ later GitHub if needed)
  Fate / DO / Think / D1 / R2
  same MergeRequestReviewApp props
```

### Host boundary

Hosts own:

- authentication (`glab`, `gh`, Worker bridge)
- process execution and credentials
- generation runtime (local agents vs Think)
- optional caching
- IPC / route state

Packages own:

- endpoint construction and provider semantics
- comparison / evolution algorithms
- projection into Core contracts
- walkthrough draft/prompt/normalize/compose

## Provider Models

### GitLab: native MR versions

Use GitLab's first-class version history.

Endpoints / package APIs:

- version list + stats
- version compare (rebase-replay preferred)
- historical commit stacks
- commit evolution + rebase drivers
- unit diffs
- `projectVersionCompare` / `projectCommitEvolution` / `projectReviewPlan`

Local transport:

```ts
createGlabGitLabTransport({ hostname, repoRoot });
```

Identity remains GitLab `{ baseSha, startSha, headSha }` inside the package.
Core only sees `DiffRange` / `ReviewVersionOption`.

### GitHub: force-push head comparisons

GitHub has no MR version list. Local parity uses **force-push head history** as
the revision timeline.

#### Revision discovery

Build an ordered list of PR head snapshots from:

1. PR timeline / issue events for force-push records
   - before/after head SHAs
   - actor + timestamp
2. current PR head as the newest endpoint
3. optional: PR base updates as base-movement context, not as head versions

Each revision becomes a Core `ReviewVersionOption`:

```ts
{
  id: afterHeadSha, // or stable derived id
  createdAt,
  number: index, // display only
  range: {
    base: baseAtThatTimeOrCurrentBase,
    head: afterHeadSha,
  }
}
```

Labels should read like:

- `Head · abc1234`
- `Force-push · def5678`
- `Current head`

not fake `v1/v2` GitLab version numbers unless we explicitly choose that UX.

#### Comparison materialization

For selected before/after heads:

1. resolve base refs (PR base at each point if available; else current base)
2. materialize `before = baseA...headA`, `after = baseB...headB`
3. prefer a rebase-replay / intentional interdiff path when blobs are available
   via local git objects
4. fall back to approximate patch-text compare when objects are missing
5. project to `DiffComparisonView`

Local git is an advantage here: after `gh` fetches the PR refs, many head SHAs
are already present and can be read without remote blob round-trips.

#### Commit evolution

Reuse the same Core/GitLab evolution concepts:

- retained
- rewritten-same-patch
- revised
- introduced
- removed
- absorbed-into-base
- ambiguous

Implementation options, in order of preference:

1. extract provider-neutral evolution pure functions already used by GitLab into
   Core or a tiny shared history module, then call them from GitHub
2. temporarily fork the algorithm behind `@nkzw/codiff-github` if extraction is
   too large for the first local commit

Do not special-case the UI for GitHub evolution kinds.

#### Comments

Associate review comments to head SHAs / positions when GitHub provides them.
Comment association quality may be weaker than GitLab's versioned positions;
surface warnings rather than inventing certainty.

## Local Product UX

For `source.type === 'pull-request'`, local Codiff should mount the shared
review surface used by Web (`MergeRequestReviewApp` / `ReviewSurface`), not a
reduced PR-only subset of `App.tsx`.

Required host-fed props:

- `state` current whole PR/MR snapshot
- `versions`
- `versionCompare` / loading / error
- `versionCommitEvolution` / loading / error
- `versionWalkthroughStructure`
- `commits` for ordinary commit-by-commit when useful
- callbacks:
  - `onVersionCompareRangeChange`
  - `onLoadCommitDiff`
  - `onLoadVersionCommitDiff`
  - `onGenerateWalkthrough`
  - exit compare / open compare

### Modes

Preserve existing review modes:

- comments
- tree / files
- commits / evolution
- walkthrough

Version compare is a scope over tree + walkthrough, as in Web.

### Walkthrough generation

Whole-diff:

1. materialize one `RepositoryState` for the selected range/compare
2. `buildWalkthroughPrompt` + local agent
3. `normalizeWalkthroughDraft`

Units:

1. `projectReviewPlan` / structure override
2. for each reviewable unit, materialize unit `RepositoryState`
3. generate each unit independently through authoring
4. `composeUnitWalkthroughs`
5. attach comment references when available

Local generation stays sequential or lightly concurrent in-process. No DO fanout
required for v1.

## Implementation Plan

### 1. Local review host shell

Switch local PR/MR presentation to the shared review app host path.

Work:

- add an Electron/renderer host container for pull-request sources
- keep working-tree / commit / branch modes on existing `App.tsx` paths
- plumb preload/IPC for history reads and scoped generation
- preserve comment submit/review actions already implemented locally

Acceptance:

- opening `codiff mr …` or `codiff pr …` renders shared review chrome
- baseline whole-MR/PR review still works with no version compare selected

### 2. GitLab local history wiring

Work:

- on GitLab MR load, create `createGlabGitLabTransport`
- fetch version history through `@nkzw/codiff-gitlab`
- fetch compare + evolution on range selection
- fetch unit diffs on demand
- project package results into Core props
- wire generate callbacks to shared authoring + local agents

Acceptance:

- version picker populated from glab-backed transport
- compare shows intentional files / base movement / evolution
- whole-diff and commit-unit walkthroughs both work offline-ish with glab auth

Tests:

- fake glab executable covering versions, compare payloads, commit stacks
- unit tests for IPC/host mapping to Core props
- one end-to-end Electron test with fixture transport

### 3. GitHub force-push history provider

Work:

- add `GitHubTransport` + `createGhGitHubTransport`
- implement revision discovery from force-push timeline/head events
- implement compare materialization using local git objects when possible
- implement evolution + plan projection to Core contracts
- wire into the same host shell as GitLab

Package shape preference:

```text
@nkzw/codiff-github
  transport interface
  force-push revision list
  compare/evolution/plan projection
```

If packaging slows the first landing, start under
`electron/git-state/github-history/` with the same public interface and move it
into a package in the release commit.

Acceptance:

- PR with force-pushes shows a head timeline
- comparing two heads materializes an interdiff-like review surface
- evolution units render in the same UI as GitLab
- no GitLab version numbering metaphors required

Tests:

- fake `gh` executable / fixture timeline payloads
- compare fixtures for rewritten commits and pure force-push rebases
- warnings when before/after heads are unavailable locally and must be fetched

### 4. Shared generation orchestration helper

Avoid two host-specific generators.

Work:

- add a small host-agnostic helper in Core or a local shared module:

```ts
generateReviewWalkthrough({
  plan,
  states, // whole or per-unit
  runModel, // host-provided
  agent,
  compose,
});
```

- local agents implement `runModel`
- Web Think path can adopt later

Acceptance:

- local GitLab and GitHub both call the same orchestration helper
- composition and prompt options remain in `walkthrough-authoring`

### 5. UX polish and parity gaps

Work:

- structure recommendation + user override
- empty/error/loading states for history reads
- comment open-in-compare affordances where positions exist
- clear provider-specific copy:
  - GitLab: “Versions”
  - GitHub: “Head history” / “Force-pushes”
- ensure CSS already in Core covers both

### 6. Release / docs

Work:

- bump package versions if GitHub package or Core orchestration lands
- update `docs/review-history-packages.md`
- document local commands and auth requirements
- keep Web migration notes explicit: local proves host wiring first

## Commit Plan

Every commit should build and test independently.

1. `Mount shared review host for local PR/MR sources`
   - shell/IPC only; no GitLab/GitHub history algorithms yet
2. `Wire GitLab review history into local Codiff`
   - glab transport + `@nkzw/codiff-gitlab` + generation
3. `Add GitHub force-push review history provider`
   - transport + revision/compare/evolution + host wiring
4. `Unify local walkthrough generation behind shared orchestration`
5. `Polish provider copy/tests and release local parity packages`

If commit 3 is large, split into:

- provider package/fixtures
- Electron wiring

## Unification With Codiff Web

This local work is not a fork. It is the second host on the same packages.

Immediate:

- local consumes released/shared packages
- proves the host adapter pattern with real UX

Next Web MR:

- delete in-tree GitLab history + authoring copies
- implement Worker `GitLabTransport`
- keep only Cloudflare orchestration/persistence

Eventually:

```text
one Core UI
one authoring module
provider packages per forge
thin hosts
```

Local-specific forever:

- glab/gh executable discovery
- local agent backends
- no multi-tenant cache

Web-specific forever:

- Access/Worker auth
- D1/R2/DO/Fate/Think

## Auth and Runtime Requirements

GitLab local:

- `glab` installed and authenticated for the MR host
- `CODIFF_GLAB_PATH` supported
- network access to GitLab API via glab

GitHub local:

- `gh` installed and authenticated
- fetch enough PR refs/commits to materialize selected heads
- network access for timeline + missing objects

Walkthroughs:

- at least one local agent backend (`codex` / `claude` / `opencode` / `pi`)

## Validation

### GitLab

- open MR with 3+ versions
- compare adjacent and distant versions
- verify base movement and evolution units
- generate whole-diff walkthrough for a compare
- generate commit-unit walkthrough and navigate unit chapters
- fake-glab tests for transport and host mapping

### GitHub

- open PR with force-push history
- verify head timeline ordering and labels
- compare pre/post force-push heads
- verify rewritten/introduced/removed classification on a known fixture
- generate whole-diff and unit walkthroughs
- fake-gh tests for timeline parsing and compare materialization

### Cross-provider

- same Core props shape into `MergeRequestReviewApp`
- same authoring module output schema
- no provider-specific React forks inside Core beyond label copy

### Regression

- working-tree review/commit flow unchanged
- ordinary PR/MR comments and submit review still work
- `codiff -w` whole-diff still works outside compare mode

## Risks

- **GitHub timeline completeness:** force-push events may be missing or partial on
  some repos/permissions. Degrade to current head only with an explicit warning.
- **Object availability:** selected heads may not exist locally. Fetch on demand;
  fail soft with actionable auth/fetch errors.
- **Algorithm drift:** do not copy evolution code differently for GitHub. Extract
  shared pure functions before dual maintenance appears.
- **UI mount churn:** moving local PR/MR onto `MergeRequestReviewApp` can regress
  comments/review buttons if actions are not plumbed carefully.
- **Performance:** naive full compare on every range change will feel slow.
  Cache last compare/evolution in memory per window; no durable cache required.

## Decision Summary

- Yes: implement local parity now.
- GitLab: package-backed native versions.
- GitHub: force-push head comparisons projected into the same Core model.
- Keep hosts thin; keep algorithms/authoring shared.
- Use local parity to finish the unification path that lets Codiff Web delete its
  duplicated history/authoring implementations.

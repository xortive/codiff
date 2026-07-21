import type {
  NarrativeWalkthrough,
  RepositoryState,
  ReviewCommitEvolution,
  ReviewPlan,
  ReviewUnit,
} from '../types.ts';
import { resolveReviewPlan, reviewableUnits } from './review-history.ts';
import {
  buildWalkthroughPrompt,
  composeUnitWalkthroughs,
  normalizeWalkthroughDraft,
  type UnitWalkthroughEntry,
  type WalkthroughPromptOptions,
} from './walkthrough-authoring.ts';

export type ReviewWalkthroughModelResult = {
  /** Raw model JSON/text payload to normalize. */
  draft: unknown;
};

export type ReviewWalkthroughRunModel = (input: {
  agent: NarrativeWalkthrough['agent'];
  prompt: string;
  state: RepositoryState;
}) => Promise<ReviewWalkthroughModelResult>;

export type GenerateReviewWalkthroughInput = {
  agent: NarrativeWalkthrough['agent'];
  /**
   * Optional evolution used when `plan` is omitted and unit generation is desired.
   * Hosts typically pass the projected Core evolution for the active compare.
   */
  evolution?: ReviewCommitEvolution | null;
  /**
   * Optional explicit plan. When omitted, resolved from evolution recommendation
   * (units if recommended and unit states exist; otherwise whole-diff).
   */
  plan?: ReviewPlan | null;
  /** Extra prompt options applied to every generation call. */
  promptOptions?: WalkthroughPromptOptions;
  /** Host-provided model runner (local agent CLI, Think, etc.). */
  runModel: ReviewWalkthroughRunModel;
  /**
   * Whole-diff state and/or per-unit states.
   * - whole-diff plan: provide `whole`
   * - units plan: provide `byUnitId` for each reviewable unit (missing units are skipped)
   */
  states: {
    byUnitId?: Readonly<Record<string, RepositoryState>>;
    whole?: RepositoryState;
  };
  /** Force whole-diff even when a units plan is available. */
  structure?: 'auto' | 'commit-by-commit' | 'whole-diff' | 'units';
};

export type GenerateReviewWalkthroughResult =
  | {
      plan: ReviewPlan;
      status: 'ready';
      walkthrough: NarrativeWalkthrough;
    }
  | {
      reason: string;
      status: 'failed';
    };

const toEvolutionKind = (
  kind: ReviewUnit['kind'],
): 'likely-revised' | 'added' | 'removed' | 'ambiguous' => {
  switch (kind) {
    case 'introduced':
      return 'added';
    case 'removed':
      return 'removed';
    case 'revised':
      return 'likely-revised';
    default:
      return 'ambiguous';
  }
};

const unitAfter = (unit: ReviewUnit) =>
  unit.kind === 'commit'
    ? unit.commit
    : unit.kind === 'introduced' || unit.kind === 'revised' || unit.kind === 'ambiguous'
      ? unit.after
      : undefined;

const unitBefore = (unit: ReviewUnit) =>
  unit.kind === 'removed' || unit.kind === 'revised' || unit.kind === 'ambiguous'
    ? unit.before
    : undefined;

const toPromptOptionsForUnit = (
  unit: ReviewUnit,
  range: { fromLabel: string; toLabel: string },
  base: WalkthroughPromptOptions | undefined,
): WalkthroughPromptOptions => {
  const after = unitAfter(unit);
  const before = unitBefore(unit);
  return {
    ...base,
    versionCommitContext: {
      evolutionKind: toEvolutionKind(unit.kind),
      kind: 'version-commit',
      range,
      unitId: unit.id,
      ...(after ? { after: { shortSha: after.shortSha, subject: after.subject } } : {}),
      ...(before ? { before: { shortSha: before.shortSha, subject: before.subject } } : {}),
      ...('rebaseDrivers' in unit && unit.rebaseDrivers
        ? {
            rebaseDrivers: unit.rebaseDrivers.map((driver) => ({
              authorName: driver.authorName,
              overlappingPaths: driver.overlappingPaths ?? [],
              shortSha: driver.shortSha,
              subject: driver.subject,
            })),
          }
        : {}),
    },
    versionCompareRange: {
      fromLabel: range.fromLabel,
      structure: 'commit-by-commit',
      toLabel: range.toLabel,
    },
  };
};

/**
 * Host-agnostic walkthrough generation orchestrator.
 *
 * Owns plan resolution + whole-diff vs unit fanout + composition.
 * Does **not** own model IDs, process execution, caching, or auth — hosts inject
 * `runModel` for that.
 *
 * ## Local vs Web
 * - Local: `runModel` shells out to codex/claude/opencode/pi and returns parsed JSON.
 * - Web (later): `runModel` calls Think/AI Gateway; Durable Object fanout can still
 *   pre-build per-unit states and call this helper once per unit or once for whole-diff.
 *
 * Prompt construction, draft normalization, and unit composition stay inside
 * `walkthrough-authoring` so both hosts cannot drift.
 */
export async function generateReviewWalkthrough(
  input: GenerateReviewWalkthroughInput,
): Promise<GenerateReviewWalkthroughResult> {
  const plan =
    input.plan ??
    resolveReviewPlan({
      recommendation: input.evolution?.recommendation,
      structure: input.structure === 'commit-by-commit' ? 'units' : input.structure,
      units: input.evolution?.units,
    });

  if (plan.structure === 'whole-diff') {
    const state = input.states.whole;
    if (!state) {
      return {
        reason: 'Whole-diff walkthrough generation requires a whole RepositoryState.',
        status: 'failed',
      };
    }
    if (state.files.length === 0) {
      return {
        reason: 'No changed files are available for walkthrough generation.',
        status: 'failed',
      };
    }
    try {
      const prompt = buildWalkthroughPrompt(state, input.promptOptions);
      const { draft } = await input.runModel({
        agent: input.agent,
        prompt,
        state,
      });
      const walkthrough = normalizeWalkthroughDraft(draft, state, input.agent);
      return { plan, status: 'ready', walkthrough };
    } catch (error: unknown) {
      return {
        reason: error instanceof Error ? error.message : String(error),
        status: 'failed',
      };
    }
  }

  const units = plan.units?.length
    ? plan.units
    : input.evolution
      ? reviewableUnits(input.evolution.units)
      : [];
  if (units.length === 0) {
    return {
      reason: 'Unit walkthrough generation requires reviewable evolution units.',
      status: 'failed',
    };
  }

  const wholeState = input.states.whole;
  if (!wholeState) {
    return {
      reason: 'Unit composition requires the parent whole RepositoryState.',
      status: 'failed',
    };
  }

  const range = {
    fromLabel: input.promptOptions?.versionCompareRange?.fromLabel ?? 'before',
    toLabel: input.promptOptions?.versionCompareRange?.toLabel ?? 'after',
  };

  const entries: Array<UnitWalkthroughEntry> = [];
  const failures: Array<string> = [];

  for (const unit of units) {
    const unitState = input.states.byUnitId?.[unit.id];
    if (!unitState || unitState.files.length === 0) {
      failures.push(`${unit.id}: missing unit diff state`);
      continue;
    }
    try {
      const prompt = buildWalkthroughPrompt(
        unitState,
        toPromptOptionsForUnit(unit, range, input.promptOptions),
      );
      const { draft } = await input.runModel({
        agent: input.agent,
        prompt,
        state: unitState,
      });
      const walkthrough = normalizeWalkthroughDraft(draft, unitState, input.agent);
      const after = unitAfter(unit);
      const before = unitBefore(unit);
      const context: UnitWalkthroughEntry['context'] = {
        kind: 'version-commit',
        range,
        unitId: unit.id,
        ...(after
          ? {
              after: {
                sha: after.sha,
                shortSha: after.shortSha,
                subject: after.subject,
                ...(after.webUrl ? { webUrl: after.webUrl } : {}),
              },
            }
          : {}),
        ...(before
          ? {
              before: {
                sha: before.sha,
                shortSha: before.shortSha,
                subject: before.subject,
                ...(before.webUrl ? { webUrl: before.webUrl } : {}),
              },
            }
          : {}),
        ...('rebaseDrivers' in unit && unit.rebaseDrivers
          ? {
              rebaseDrivers: unit.rebaseDrivers.map((driver) => ({
                ...(driver.authoredAt ? { authoredAt: driver.authoredAt } : {}),
                ...(driver.authorName ? { authorName: driver.authorName } : {}),
                ...(driver.overlappingPaths
                  ? { overlappingPaths: [...driver.overlappingPaths] }
                  : {}),
                ...(driver.sha ? { sha: driver.sha } : {}),
                shortSha: driver.shortSha,
                subject: driver.subject,
                ...(driver.webUrl ? { webUrl: driver.webUrl } : {}),
              })),
            }
          : {}),
      };
      entries.push({
        context,
        state: unitState,
        walkthrough,
      });
    } catch (error: unknown) {
      failures.push(`${unit.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (entries.length === 0) {
    return {
      reason:
        failures.length > 0
          ? `All unit walkthroughs failed. ${failures.join('; ')}`
          : 'No unit walkthroughs were generated.',
      status: 'failed',
    };
  }

  const walkthrough = composeUnitWalkthroughs({
    agent: input.agent,
    entries,
    state: wholeState,
  });

  return { plan, status: 'ready', walkthrough };
}

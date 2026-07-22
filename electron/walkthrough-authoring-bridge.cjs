// @ts-check

/**
 * CJS bridge to Core walkthrough-authoring (ESM).
 */

const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

/** @type {Promise<typeof import('../core/dist/walkthrough-authoring.mjs')> | null} */
let modulePromise = null;

const loadAuthoring = () => {
  if (!modulePromise) {
    const modulePath = join(__dirname, '../core/dist/walkthrough-authoring.mjs');
    modulePromise = import(pathToFileURL(modulePath).href);
  }
  return modulePromise;
};

/**
 * @param {unknown} value
 * @param {import('../core/types.ts').RepositoryState} state
 * @param {import('../core/types.ts').NarrativeWalkthrough['agent']} agent
 * @param {ReadonlyMap<string, string>} [hunkIdByAlias]
 */
const normalizeNarrativeWalkthrough = async (value, state, agent, hunkIdByAlias) => {
  const authoring = await loadAuthoring();
  // When aliases are present, rewrite draft hunk ids back through the map first.
  let draft = value;
  if (hunkIdByAlias && hunkIdByAlias.size > 0 && value && typeof value === 'object') {
    const rewriteIds = (ids) =>
      Array.isArray(ids)
        ? ids.map((id) => (typeof id === 'string' ? (hunkIdByAlias.get(id) ?? id) : id))
        : ids;
    const input = /** @type {any} */ (value);
    draft = {
      ...input,
      chapters: Array.isArray(input.chapters)
        ? input.chapters.map((chapter) => ({
            ...chapter,
            stops: Array.isArray(chapter?.stops)
              ? chapter.stops.map((stop) => ({
                  ...stop,
                  hunkIds: rewriteIds(stop?.hunkIds),
                  notes: Array.isArray(stop?.notes)
                    ? stop.notes.map((note) => ({
                        ...note,
                        hunkId:
                          typeof note?.hunkId === 'string'
                            ? (hunkIdByAlias.get(note.hunkId) ?? note.hunkId)
                            : note?.hunkId,
                      }))
                    : stop?.notes,
                }))
              : chapter?.stops,
          }))
        : input.chapters,
      support: Array.isArray(input.support)
        ? input.support.map((item) => ({
            ...item,
            hunkIds: rewriteIds(item?.hunkIds),
          }))
        : input.support,
    };
  }
  return authoring.normalizeWalkthroughDraft(draft, state, agent);
};

/**
 * @param {import('../core/types.ts').RepositoryState} state
 * @param {unknown} [options]
 */
const buildWalkthroughPrompt = async (state, options) => {
  const authoring = await loadAuthoring();
  return authoring.buildWalkthroughPrompt(state, options ?? {});
};

/**
 * @param {import('../core/types.ts').RepositoryState} state
 * @param {unknown} [options]
 */
const buildWalkthroughPromptInput = async (state, options) => {
  const authoring = await loadAuthoring();
  return authoring.buildWalkthroughPromptInput(state, options ?? {});
};

module.exports = {
  buildWalkthroughPrompt,
  buildWalkthroughPromptInput,
  loadAuthoring,
  normalizeNarrativeWalkthrough,
};

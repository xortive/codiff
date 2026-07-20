// @ts-check

/**
 * Forward semantic walkthrough stages and detailed unit progress. The renderer
 * decides which events change the visible stage.
 *
 * @param {Pick<Electron.WebContents, 'isDestroyed' | 'send'>} webContents
 * @param {() => boolean} [isCurrent]
 */
const createWalkthroughProgressReporter = (webContents, isCurrent = () => true) => {
  /** @param {import('../core/types.ts').WalkthroughProgressEvent['phase'] | import('../core/types.ts').WalkthroughGenerationProgress} update */
  return (update) => {
    if (webContents.isDestroyed() || !isCurrent()) {
      return;
    }

    /** @type {import('../core/types.ts').WalkthroughProgressEvent} */
    const progress = typeof update === 'string' ? { phase: update } : { generation: update };
    webContents.send('codiff:walkthroughProgress', progress);
  };
};

module.exports = { createWalkthroughProgressReporter };

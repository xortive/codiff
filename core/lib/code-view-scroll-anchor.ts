type CodeViewScrollAnchor = {
  id: string;
  type: 'item' | 'line';
  viewportOffset: number;
};

type CodeViewWithScrollAnchoring = {
  getScrollAnchor?: (
    scrollTop: number,
    ...args: ReadonlyArray<unknown>
  ) => CodeViewScrollAnchor | undefined;
  getTopForItem: (id: string) => number | undefined;
};

// Pierre's line-level anchor can resolve to a different virtual line position when a later
// walkthrough item enters the render window. The item itself has a stable absolute top, so use
// that as the anchor while retaining Pierre's normal item-level layout correction.
export const installStableWalkthroughScrollAnchoring = (viewer: unknown) => {
  const internal = viewer as CodeViewWithScrollAnchoring;
  const original = internal.getScrollAnchor;
  if (!original || typeof internal.getTopForItem !== 'function') {
    return () => {};
  }

  const getStableScrollAnchor: typeof original = (scrollTop, ...args) => {
    const anchor = original.call(internal, scrollTop, ...args);
    if (anchor?.type !== 'line') {
      return anchor;
    }
    const itemTop = internal.getTopForItem(anchor.id);
    return itemTop == null
      ? undefined
      : { id: anchor.id, type: 'item', viewportOffset: itemTop - scrollTop };
  };
  internal.getScrollAnchor = getStableScrollAnchor;

  return () => {
    if (internal.getScrollAnchor === getStableScrollAnchor) {
      internal.getScrollAnchor = original;
    }
  };
};

/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import {
  nextWalkthroughResponseLabelIndex,
  WalkthroughProgress,
  walkthroughResponseLabels,
} from '../app/components/walkthrough/WalkthroughProgress.tsx';

afterEach(() => {
  vi.useRealTimers();
});

test('cycles through polished response labels once per walkthrough', () => {
  expect(walkthroughResponseLabels).toEqual([
    'Building walkthrough…',
    'Composing walkthrough…',
    'Writing walkthrough…',
    'Assembling walkthrough…',
    'Creating walkthrough…',
    'Producing walkthrough…',
  ]);
  expect(
    walkthroughResponseLabels.map((_, index) => nextWalkthroughResponseLabelIndex(index)),
  ).toEqual([1, 2, 3, 4, 5, 0]);
});

test('reserves timer space, reveals 3s without shifting, and resets for each stage', async () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = createRoot(container);

  try {
    await act(async () => {
      root?.render(<WalkthroughProgress phase={null} responseLabelIndex={0} stageRevision={0} />);
    });

    const timer = () => container.querySelector<HTMLElement>('.walkthrough-progress-timer');
    expect(container.textContent).toContain('Generating walkthrough…');
    expect(timer()?.textContent).toBe('0s');
    expect(timer()?.classList.contains('visible')).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(timer()?.textContent).toBe('3s');
    expect(timer()?.classList.contains('visible')).toBe(true);

    await act(async () => {
      root?.render(
        <WalkthroughProgress phase="agent-generation" responseLabelIndex={0} stageRevision={1} />,
      );
    });
    expect(container.textContent).toContain('Analyzing changes…');
    expect(timer()?.textContent).toBe('0s');
    expect(timer()?.classList.contains('visible')).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(timer()?.textContent).toBe('3s');

    await act(async () => {
      root?.render(
        <WalkthroughProgress phase="agent-generation" responseLabelIndex={0} stageRevision={1} />,
      );
    });
    expect(container.textContent).toContain('Analyzing changes…');
    expect(timer()?.textContent).toBe('3s');
    expect(timer()?.classList.contains('visible')).toBe(true);

    await act(async () => {
      root?.render(
        <WalkthroughProgress phase="response-received" responseLabelIndex={4} stageRevision={2} />,
      );
    });
    expect(container.textContent).toContain('Creating walkthrough…');
    expect(timer()?.textContent).toBe('0s');
    expect(timer()?.classList.contains('visible')).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(timer()?.textContent).toBe('3s');
    expect(timer()?.classList.contains('visible')).toBe(true);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
  }
});

test('renders a detailed commit-unit preparation status', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = createRoot(container);

  try {
    await act(async () => {
      root?.render(
        <WalkthroughProgress
          phase={null}
          progress={{
            completed: 1,
            phase: 'preparing',
            summary: 'Preparing aaaaaaa Add review focus.',
            total: 2,
            units: [
              { id: 'introduced:a', label: 'aaaaaaa Add review focus', status: 'ready' },
              {
                detail: 'Loading commit diff…',
                id: 'introduced:b',
                label: 'bbbbbbb Render commit pills',
                status: 'generating',
              },
            ],
          }}
          responseLabelIndex={0}
          stageRevision={0}
        />,
      );
    });

    expect(container.textContent).toContain('1/2');
    expect(container.textContent).toContain('Preparing aaaaaaa Add review focus.');
    expect(container.textContent).toContain('done');
    expect(container.textContent).toContain('generating');
    expect(container.textContent).toContain('bbbbbbb Render commit pills');
  } finally {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
  }
});

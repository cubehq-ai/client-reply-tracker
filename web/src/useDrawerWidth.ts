import { useCallback, useState } from 'react';

const WIDTH_KEY = 'rq.drawer.width';
const MIN_WIDTH = 420;

/**
 * Drag-to-resize for the side drawer, remembered per browser.
 *
 * Shared so every drawer behaves the same: a panel that cannot be widened is
 * the wrong width for someone, and the mail drawer has had this since the
 * start.
 */
export function useDrawerWidth(defaultWidth = 780): {
  width: number;
  startResize: (e: React.MouseEvent) => void;
} {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : defaultWidth;
  });

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent): void => {
      setWidth(Math.min(window.innerWidth - 120, Math.max(MIN_WIDTH, window.innerWidth - ev.clientX)));
    };
    const stop = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      document.body.style.userSelect = '';
      setWidth((w) => { localStorage.setItem(WIDTH_KEY, String(w)); return w; });
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  }, []);

  return { width, startResize };
}

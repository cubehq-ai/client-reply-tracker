import { useEffect, useRef, useState } from 'react';

export interface Option {
  value: string;
  label: string;
}

/**
 * A multi-select filter.
 *
 * The trigger always shows the filter's name, with a count when something is
 * selected, so the row of filters stays readable instead of turning into a row
 * of whichever values happen to be chosen.
 */
export function MultiSelect({ label, options, selected, onChange, searchable }: {
  label: string;
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Adds a search box; worth it once there are many options. */
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const visible = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  const selectedSet = new Set(selected);
  const allVisibleSelected = visible.length > 0 && visible.every((o) => selectedSet.has(o.value));

  function toggle(value: string) {
    const next = new Set(selectedSet);
    next.has(value) ? next.delete(value) : next.add(value);
    onChange([...next]);
  }

  function toggleAll() {
    if (allVisibleSelected) {
      const next = new Set(selectedSet);
      for (const o of visible) next.delete(o.value);
      onChange([...next]);
    } else {
      onChange([...new Set([...selected, ...visible.map((o) => o.value)])]);
    }
  }

  return (
    <div className="multiselect" ref={root}>
      <button
        type="button"
        className={`multiselect-trigger ${selected.length ? 'has-selection' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{label}</span>
        {selected.length > 0 && <span className="multiselect-count">{selected.length}</span>}
        <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true" className="multiselect-caret">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="multiselect-panel">
          {searchable && (
            <input
              className="multiselect-search"
              type="search"
              autoFocus
              placeholder={`Search ${label.toLowerCase()}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}

          <label className="multiselect-option multiselect-all">
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} />
            <span>{allVisibleSelected ? 'Clear all' : 'Select all'}</span>
            {selected.length > 0 && <span className="multiselect-opt-n">{selected.length} selected</span>}
          </label>

          <div className="multiselect-list">
            {visible.length === 0 && <div className="multiselect-empty">No matches</div>}
            {visible.map((o) => (
              <label key={o.value} className="multiselect-option">
                <input type="checkbox" checked={selectedSet.has(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

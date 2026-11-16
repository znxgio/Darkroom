// Default "type today's value" components, picked by tracker kind.
// A tracker can bring its own via `entryComponent` in the registry.
import { useState, type FormEvent } from 'react';
import type { EntryComponentProps, TrackerDef } from './registry';
import { num, text } from './registry';

export function NumberEntry({ def, initial, saving, onSave, onCancel, hint }: EntryComponentProps) {
  const start = num(initial);
  const [input, setInput] = useState(start === null ? '' : start.toFixed(def.decimals ?? 0));
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const r = def.parse(input);
    if (typeof r === 'string') {
      setError(r);
      return;
    }
    setError(null);
    onSave(r);
  }

  return (
    <form className="tracker-entry" onSubmit={submit} noValidate>
      <div className="tracker-entry-row">
        <label className={`num-input${error ? ' invalid' : ''}`}>
          <span className="sr-only">{def.name} today</span>
          <input
            data-testid={`tracker-input-${def.key}`}
            type="text"
            inputMode="decimal"
            enterKeyHint="done"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={hint ?? def.placeholder ?? ''}
            value={input}
            aria-invalid={!!error}
            onChange={(e) => {
              setInput(e.target.value);
              if (error) setError(null);
            }}
          />
          {def.unit && <span className="num-unit">{def.unit}</span>}
        </label>
        <button
          type="submit"
          className="btn primary"
          data-testid={`tracker-save-${def.key}`}
          disabled={saving || !input.trim()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {onCancel && (
        <button type="button" className="link-btn entry-cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
      {error && (
        <p className="tracker-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function TextEntry({ def, initial, saving, onSave, onCancel }: EntryComponentProps) {
  const [input, setInput] = useState(text(initial) ?? '');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="tracker-entry"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const r = def.parse(input);
        if (typeof r === 'string') return setError(r);
        setError(null);
        onSave(r);
      }}
    >
      <textarea
        data-testid={`tracker-input-${def.key}`}
        rows={3}
        placeholder={def.placeholder ?? ''}
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <div className="sheet-actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn primary" data-testid={`tracker-save-${def.key}`} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error && (
        <p className="tracker-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** The entry component for a tracker: its own, or the default for its kind. */
export function entryFor(def: TrackerDef) {
  return def.entryComponent ?? (def.kind === 'number' ? NumberEntry : TextEntry);
}

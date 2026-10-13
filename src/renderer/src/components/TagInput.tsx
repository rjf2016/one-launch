import { X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { ACCOUNT_LIMITS, normalizeTags } from '@shared/models';

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

/** Chip-style tag editor. Enter, comma, or Tab commits the pending text; Backspace on empty removes the last tag. */
export function TagInput({ value, onChange, placeholder = 'Add a tag', disabled }: TagInputProps) {
  const [pending, setPending] = useState('');

  function commit(): void {
    const next = normalizeTags([...value, ...pending.split(',')]);
    if (next.length !== value.length || next.some((t, i) => t !== value[i])) onChange(next);
    setPending('');
  }

  function remove(index: number): void {
    onChange(value.filter((_, i) => i !== index));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && pending.trim())) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !pending && value.length > 0) {
      e.preventDefault();
      remove(value.length - 1);
    }
  }

  const full = value.length >= ACCOUNT_LIMITS.tagCount;

  return (
    <div
      className={`flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2 py-1.5 transition-colors duration-150 focus-within:border-accent ${
        disabled ? 'opacity-60' : ''
      }`}
    >
      {value.map((tag, i) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-xs text-text-strong">
          {tag}
          {disabled ? null : (
            <button type="button" onClick={() => remove(i)} aria-label={`Remove tag ${tag}`} className="rounded text-muted hover:text-text [&>svg]:size-3">
              <X />
            </button>
          )}
        </span>
      ))}
      <input
        type="text"
        value={pending}
        disabled={disabled || full}
        placeholder={full ? 'Tag limit reached' : value.length === 0 ? placeholder : ''}
        maxLength={ACCOUNT_LIMITS.tagLength}
        onChange={(e) => setPending(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => pending.trim() && commit()}
        spellCheck={false}
        className="min-w-24 flex-1 bg-transparent px-1 py-0.5 text-sm text-text placeholder:text-faint focus:outline-none"
      />
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}

export function Toggle({ checked, onChange, disabled, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-150 disabled:opacity-50 ${
        checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface-3'
      }`}
    >
      <span className={`absolute top-0.5 size-[18px] rounded-full bg-white shadow transition-[left] duration-150 ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

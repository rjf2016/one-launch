import type { ComponentProps, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ComponentProps<'button'> {
  variant?: Variant;
  icon?: ReactNode;
}

const base = 'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-150 disabled:opacity-50';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover disabled:hover:bg-accent',
  secondary: 'bg-surface-2 text-text border border-border hover:bg-surface-3 hover:border-border-strong disabled:hover:bg-surface-2',
  ghost: 'text-muted hover:text-text hover:bg-surface-2',
  danger: 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20 hover:border-danger/70 disabled:hover:bg-danger/10',
};

export function Button({ variant = 'secondary', icon, className = '', children, ...rest }: ButtonProps) {
  return (
    <button type="button" className={`${base} ${variants[variant]} ${className}`} {...rest}>
      {icon ? <span className="[&>svg]:size-4">{icon}</span> : null}
      {children}
    </button>
  );
}

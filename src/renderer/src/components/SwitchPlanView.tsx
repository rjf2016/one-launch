import { AlertTriangle, Archive, FileText, Hourglass, Info, Play, Power, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { LAUNCHER_DISPLAY_NAMES, type SwitchPlan, type SwitchStepKind } from '@shared/models';
import { StatusPill } from './StatusPill';

const KIND_ICON: Record<SwitchStepKind, ReactNode> = {
  process: <Power />,
  backup: <Archive />,
  file: <FileText />,
  registry: <SlidersHorizontal />,
  launch: <Play />,
  wait: <Hourglass />,
};

const KIND_LABEL: Record<SwitchStepKind, string> = {
  process: 'Process',
  backup: 'Backup',
  file: 'File',
  registry: 'Registry',
  launch: 'Launch',
  wait: 'Wait',
};

/** Renders a dry-run switch plan: every process, file, and registry key a real switch would touch. */
export function SwitchPlanView({ plan }: { plan: SwitchPlan }) {
  const active = plan.steps.filter((s) => !s.skipped).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <StatusPill tone={plan.strategy === 'remembered' ? 'ok' : 'warn'}>
          {plan.strategy === 'remembered' ? 'Remembered session' : 'Needs credentials'}
        </StatusPill>
        <StatusPill tone={plan.executable ? 'info' : 'fail'}>
          {plan.executable ? `${active} of ${plan.steps.length} steps would run` : 'Cannot run yet'}
        </StatusPill>
        <span>
          {LAUNCHER_DISPLAY_NAMES[plan.launcher]} is {plan.current.running ? 'running' : 'not running'}
          {plan.current.mostRecentLogin ? `, currently set to sign in as ${plan.current.mostRecentLogin}` : ''}.
        </span>
      </div>

      {plan.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
          {plan.warnings.map((w) => (
            <li key={w} className="flex items-start gap-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {plan.notes.length > 0 ? (
        <ul className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-2/60 px-3 py-2">
          {plan.notes.map((n) => (
            <li key={n} className="flex items-start gap-2 text-xs text-muted">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <ol className="flex flex-col gap-2">
        {plan.steps.map((s, i) => (
          <li
            key={`${s.kind}-${s.title}`}
            className={`rounded-lg border px-3 py-2.5 ${s.skipped ? 'border-border/60 bg-surface-2/30 opacity-60' : 'border-border bg-surface-2/60'}`}
          >
            <div className="flex items-center gap-2.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-muted [&>svg]:size-3.5">
                {KIND_ICON[s.kind]}
              </span>
              <span className="text-xs text-faint">{i + 1}.</span>
              <span className="text-sm font-medium text-text-strong">{s.title}</span>
              <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-muted">{KIND_LABEL[s.kind]}</span>
              {s.skipped ? <span className="text-[11px] text-faint">skipped</span> : null}
            </div>
            <div className="mt-1.5 ml-[34px] flex flex-col gap-1.5">
              <div className="font-mono text-xs break-all text-muted select-text">{s.target}</div>
              <p className="text-xs leading-relaxed text-text select-text">{s.detail}</p>
              {s.changes.length > 0 ? (
                <table className="mt-1 w-full border-collapse text-xs">
                  <tbody>
                    {s.changes.map((c) => (
                      <tr key={`${c.where}-${c.after}`} className="border-t border-border/60">
                        <td className="w-24 py-1 pr-3 align-top text-faint">{c.where}</td>
                        <td className="py-1 pr-3 align-top font-mono text-danger/80 select-text">{c.before || '(none)'}</td>
                        <td className="w-6 py-1 align-top text-faint">→</td>
                        <td className="py-1 align-top font-mono text-success select-text">{c.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="text-[11px] text-faint">Generated {new Date(plan.generatedAt).toLocaleString()}. This is a preview: nothing was changed.</p>
    </div>
  );
}

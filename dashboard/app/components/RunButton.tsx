'use client';

/**
 * Shared run-trigger button for workflow run actions. Wraps the `.btn.btn-run`
 * class idiom and centralises the "already running" disabled/title state so
 * each page doesn't re-implement it independently.
 *
 * Props:
 *   isRunning  – true while the workflow already has an active run
 *   busy       – true while the current click is in flight (optional; defaults to false)
 *   onClick    – called when the user clicks the button
 *   label      – override the default "▶ Run now" label (optional)
 *   runningLabel – override the default "Running…" label (optional)
 *   variant    – 'run' (accent `.btn-run`, default) or 'secondary' (`.btn.secondary`,
 *                used by the compact Overview workflow cards)
 */

interface RunButtonProps {
  isRunning: boolean;
  busy?: boolean;
  onClick?: () => void;
  label?: string;
  runningLabel?: string;
  className?: string;
  variant?: 'run' | 'secondary';
}

export function RunButton({
  isRunning,
  busy = false,
  onClick,
  label = '▶ Run now',
  runningLabel = 'Running…',
  className,
  variant = 'run',
}: RunButtonProps) {
  const disabled = isRunning || busy;
  const title = isRunning
    ? 'A run is already in progress — only one run per workflow at a time'
    : undefined;
  const variantClass = variant === 'secondary' ? 'secondary' : 'btn-run';
  const cls = ['btn', variantClass, className].filter(Boolean).join(' ');

  return (
    <button className={cls} onClick={onClick} disabled={disabled} title={title}>
      {isRunning ? runningLabel : busy ? 'Started…' : label}
    </button>
  );
}

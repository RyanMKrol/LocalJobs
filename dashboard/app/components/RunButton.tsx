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
 */

interface RunButtonProps {
  isRunning: boolean;
  busy?: boolean;
  onClick?: () => void;
  label?: string;
  runningLabel?: string;
  className?: string;
}

export function RunButton({
  isRunning,
  busy = false,
  onClick,
  label = '▶ Run now',
  runningLabel = 'Running…',
  className,
}: RunButtonProps) {
  const disabled = isRunning || busy;
  const title = isRunning
    ? 'A run is already in progress — only one run per workflow at a time'
    : undefined;
  const cls = ['btn', 'btn-run', className].filter(Boolean).join(' ');

  return (
    <button className={cls} onClick={onClick} disabled={disabled} title={title}>
      {isRunning ? runningLabel : busy ? 'Started…' : label}
    </button>
  );
}

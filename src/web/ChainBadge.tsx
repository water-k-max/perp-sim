import { chainLabel, type ChainReport } from './dto.js';

/**
 *  Which network this page is reading, in the words the server gave it.
 *
 *  `undefined` is the read in flight and `null` is a read that failed; neither is allowed to show a
 *  network name, because a name nobody asked about is exactly how a repointed server keeps looking
 *  normal. The dot takes its colour from the state so a mismatch never reads as healthy.
 */
export function ChainBadge({ report }: { report: ChainReport | null | undefined }) {
  const state = report === undefined ? 'pending' : report === null ? 'unknown' : report.agrees ? 'live' : 'mismatch';
  const label = report === undefined ? 'Checking chain' : chainLabel(report);
  return <div className="region" data-state={state}>
    <i aria-hidden="true" /> {label} <span>{state === 'mismatch' ? 'Reads and labels differ' : 'Read-only region'}</span>
  </div>;
}

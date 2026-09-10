import React from 'react';
import { Zap } from 'lucide-react';
import { BatterySnapshot } from '../../types';
import { batteryView } from '../../utils/battery';

const toneClass = {
  muted: 'text-slate-500', ready: 'text-emerald-600', warning: 'text-amber-600', danger: 'text-red-600',
};

export const BatteryIndicator: React.FC<{ snapshot: BatterySnapshot | null; connected: boolean }> = ({ snapshot, connected }) => {
  const view = batteryView(snapshot, { connected });
  return <span className={`inline-flex flex-wrap items-center gap-1.5 text-sm ${toneClass[view.tone]}`}
    title={view.hint} aria-label={`Battery: ${view.text}, ${view.status}`}>
    <svg width="25" height="16" viewBox="0 0 25 16" role="meter" aria-label="Battery level"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.fillPercent ?? undefined}
      aria-valuetext={view.fillPercent === null ? `Unknown, ${view.status}` : `${view.text}, ${view.status}`}
      className={view.fillPercent === null ? 'text-slate-400' : ''}>
      <rect x="1" y="1" width="20" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M23 5v6" stroke="currentColor" strokeWidth="2" />
      {view.fillPercent === null
        ? <path d="M7 8h8" stroke="currentColor" strokeWidth="1.5" />
        : <rect x="3" y="3" width={16 * view.fillPercent / 100} height="10" rx="1" fill="currentColor" />}
    </svg>
    {view.charging === true && <Zap size={13} aria-label="Charging" />}
    <span className="tabular-nums">{view.text}</span>
    {view.status !== 'NORMAL' && <span className="text-[10px] font-semibold tracking-wide">{view.status}</span>}
  </span>;
};

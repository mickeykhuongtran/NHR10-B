import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { PageHeader } from './PageHeader';
import { ConnectionStatus, LogEntry, Settings } from '../../types';
import { bleService } from '../../services/bleService';

interface DebugTabProps {
  logs: LogEntry[];
  settings: Settings;
  status: ConnectionStatus;
  isBusy: boolean;
  onConnect: () => void;
  onDownloadHistory: () => void;
  onClearLogs: () => void;
  onShowPopup: (content: string, time: number, beep: boolean) => void;
  isFileTransferring: boolean;
  transferProgress: number;
}

export const DebugTab: React.FC<DebugTabProps> = ({ logs, settings, status, isBusy, onConnect, onDownloadHistory, onClearLogs, onShowPopup }) => {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [popupContent, setPopupContent] = useState('Hello!');
  const [popupTime, setPopupTime] = useState('2000');
  const [beep, setBeep] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const connected = status === 'connected';
  const battery = settings.batterySnapshot;
  const visibleLogs = useMemo(() => logs.filter(log => (filter === 'all' || log.type === filter) && log.message.toLowerCase().includes(query.toLowerCase())), [logs, filter, query]);
  const run = async (action: () => void) => {
    setPending(true); setActionError('');
    try { await action(); } catch (error) { setActionError(error instanceof Error ? error.message : 'Device command failed.'); } finally { setPending(false); }
  };
  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visibleLogs, follow]);
  const telemetry = [
    ['Connection', status],
    ['Canonical ID', settings.deviceCanonicalId || 'Not available'],
    ['Firmware', connected ? settings.version || 'Not reported' : 'Not connected'],
    ['Battery', battery ? `${battery.voltageMv} mV · ${battery.stale ? 'Stale' : 'Latest sample'}` : 'Not reported'],
    ['Temperature', connected ? `${settings.temperature} °C` : 'Not available'],
    ['Charger', battery ? `${battery.chargePhase ?? 'Unknown'}${battery.chargerFaultMask !== undefined ? ' · Fault mask ' + battery.chargerFaultMask : ''}` : 'Not reported'],
  ];
  return <div className="page-content">
    <PageHeader title="Diagnostics" subtitle="Inspect device status, reproduce an issue, and export a report for service." actions={<Button variant="outline" onClick={onDownloadHistory}>Export service report</Button>} />
    <section className="shrink-0 rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-semibold">{settings.deviceName || 'NHR-10 reader'}</h2><p className="mt-1 text-xs text-slate-500">Live device information · Battery gauge is derived from voltage</p></div>
        <Button variant="outline" disabled={pending || isBusy || status === 'connecting'} onClick={connected ? () => void run(() => bleService.getSettings()) : onConnect}>{connected ? 'Refresh device info' : status === 'connecting' ? 'Connecting…' : 'Connect device'}</Button>
      </div>
      <dl className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">{telemetry.map(([label, value]) => <div key={label}><dt className="text-xs text-slate-400">{label}</dt><dd className="mt-1 break-all font-mono text-sm text-slate-700">{value}</dd></div>)}</dl>
    </section>
    <details className="shrink-0 rounded-xl border border-slate-200 bg-white">
      <summary className="px-5 py-4 text-sm font-medium">Display & buzzer test <span className="ml-2 text-xs font-normal text-slate-400">Show a message on the reader</span></summary>
      <div className="border-t border-slate-100 p-5">
        <div className="grid items-end gap-4 sm:grid-cols-[1fr_140px_auto]"><Input label="Message (up to 15 characters)" value={popupContent} onChange={e => setPopupContent(e.target.value)} maxLength={15} /><Input label="Duration (ms)" type="number" min={100} max={10000} value={popupTime} onChange={e => setPopupTime(e.target.value)} /><label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={beep} onChange={e => setBeep(e.target.checked)} />Beep</label></div>
        <Button className="mt-4" variant="outline" disabled={!connected || isBusy || pending || !popupContent.trim() || !Number.isInteger(Number(popupTime)) || Number(popupTime) < 100 || Number(popupTime) > 10000} onClick={() => void run(() => onShowPopup(popupContent, Number(popupTime), beep))}>Test on reader</Button>
        <p className="mt-3 text-xs text-slate-500">The message appears on the device display for the selected duration.</p>
      </div>
    </details>
    {actionError && <p role="alert" className="text-sm text-red-700">{actionError}</p>}
    <section className="flex min-h-[360px] flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4"><div><h2 className="text-sm font-semibold">Communication log</h2><p className="mt-1 text-xs text-slate-500">{visibleLogs.length} shown · {logs.length} retained · latest 1,000 events</p></div><button className="text-action !text-slate-500 disabled:opacity-40" disabled={!logs.length} onClick={onClearLogs}>Clear log</button></div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
        <select aria-label="Filter log events" className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All events</option><option value="error">Errors</option><option value="tx">Sent (TX)</option><option value="rx">Received (RX)</option><option value="info">Information</option></select>
        <input aria-label="Search communication log" className="min-w-0 flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm" placeholder="Search log…" value={query} onChange={e => setQuery(e.target.value)} />
        <label className="flex items-center gap-2 text-xs text-slate-500"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />Follow latest</label>
      </div>
      <div ref={scrollRef} className="min-h-[220px] flex-1 overflow-y-auto bg-[#111827] p-4 font-mono text-xs leading-6" aria-label="Device communication events">
        {!visibleLogs.length && <p className="py-10 text-center text-slate-400">{logs.length ? 'No events match your filter.' : 'Connect the reader, then perform an operation to record diagnostic events.'}</p>}
        {visibleLogs.map((log, index) => <div key={`${log.timestamp}:${index}`} className="flex items-start gap-3 border-b border-white/5 py-1"><time className="shrink-0 text-slate-500">{new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}</time><span className={`w-10 shrink-0 uppercase ${log.type === 'error' ? 'text-red-400' : log.type === 'tx' ? 'text-blue-400' : log.type === 'rx' ? 'text-emerald-400' : 'text-slate-400'}`}>{log.type}</span><span className={`min-w-0 break-all ${log.type === 'error' ? 'text-red-300' : 'text-slate-200'}`}>{log.message}</span></div>)}
      </div>
    </section>
    <p className="shrink-0 text-xs leading-5 text-slate-500">For service: connect the reader → reproduce the issue → export the service report. The report includes device identity, configuration, telemetry, and the retained communication log.</p>
  </div>;
};

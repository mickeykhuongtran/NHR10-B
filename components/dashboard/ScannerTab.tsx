import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, Play, Square } from 'lucide-react';
import AutoSizer from 'react-virtualized-auto-sizer';
import { FixedSizeList as List } from 'react-window';
import { Button } from '../ui/Button';
import { PageHeader } from './PageHeader';
import { BatchSaveInfo, ScanStats, Tag } from '../../types';

const PRESETS = [
  { mode: 'standard', label: 'Standard', purpose: 'Everyday inventory and general tag reading. Start here for routine scans.', detail: 'Profile 53, Q4, S1, Tag Focus on' },
  { mode: 'quick', label: 'Quick', purpose: 'Small groups of nearby tags, with an emphasis on quick, repeated reads.', detail: 'Profile 11, Q2, S0, Tag Focus off' },
  { mode: 'deep', label: 'Deep', purpose: 'Try an alternative RF link when tags are difficult to read or reads are intermittent.', detail: 'Profile 13, Q4, S1, Tag Focus on' },
] as const;
type Preset = typeof PRESETS[number]['mode'];

interface ScannerTabProps {
  isConnected: boolean;
  isConnecting: boolean;
  isBusy: boolean;
  onConnect: () => void;
  isScanning: boolean;
  activeScanType: 'interactive' | 'batch' | null;
  scanStartedAt: number | null;
  scanStoppedAt: number | null;
  removeStaleTags: boolean;
  staleRemoveMs: number;
  onChangeRemoveStaleTags: (enabled: boolean) => void;
  onChangeStaleRemoveMs: (value: number) => void;
  onStartScan: () => void;
  onStopScan: () => void;
  onStartBatch: () => void;
  onStopBatch: () => void;
  onClear: () => void;
  tags: Tag[];
  stats: ScanStats;
  onApplyPreset: (mode: Preset) => void;
  isBatchSaving: boolean;
  batchSaveInfo: BatchSaveInfo;
  excludedEpcs: string[];
  excludedSnapshots: Record<string, Tag>;
  setExcludedEpcs: React.Dispatch<React.SetStateAction<string[]>>;
  setExcludedSnapshots: React.Dispatch<React.SetStateAction<Record<string, Tag>>>;
  onChooseTag: (epc: string) => void;
  onOpenStorage: () => void;
}

const count = (n: number) => Math.max(0, Math.trunc(n || 0)).toLocaleString();
const duration = (start: number | null, end: number | null) => {
  const seconds = start && end ? Math.max(0, Math.floor((end - start) / 1000)) : 0;
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
};

export const ScannerTab: React.FC<ScannerTabProps> = (props) => {
  const [panel, setPanel] = useState<'live' | 'excluded'>('live');
  const [now, setNow] = useState(Date.now());
  const [mobile, setMobile] = useState(() => window.innerWidth < 640);
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');
  const [controlError, setControlError] = useState('');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [timeoutInput, setTimeoutInput] = useState(String(props.staleRemoveMs));
  const [showGuide, setShowGuide] = useState(false);
  const supported = 'bluetooth' in navigator && window.isSecureContext;
  const excluded = useMemo(() => new Set(props.excludedEpcs), [props.excludedEpcs]);
  const liveTags = useMemo(() => props.tags.filter(tag => !excluded.has(tag.epc)), [props.tags, excluded]);
  const excludedTags = useMemo(() => {
    const liveMap = new Map(props.tags.map(tag => [tag.epc, tag]));
    return props.excludedEpcs.map(epc => liveMap.get(epc) ?? props.excludedSnapshots[epc] ?? { epc, timestamp: 0, count: 0 });
  }, [props.tags, props.excludedEpcs, props.excludedSnapshots]);
  const rows = panel === 'live' ? liveTags : excludedTags;
  const locked = !props.isConnected || props.isBusy || props.isBatchSaving || pending;
  const batch = props.activeScanType === 'batch';
  const live = props.activeScanType === 'interactive';

  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!props.isScanning) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [props.isScanning]);
  useEffect(() => setTimeoutInput(String(props.staleRemoveMs)), [props.staleRemoveMs]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  // Preserve the last observed tag when automatic stale removal removes it from live data.
  useEffect(() => {
    if (!props.excludedEpcs.length) return;
    props.setExcludedSnapshots(current => {
      const next = { ...current };
      for (const tag of props.tags) if (excluded.has(tag.epc)) next[tag.epc] = tag;
      return next;
    });
  }, [props.tags, excluded, props.setExcludedSnapshots]);

  const run = async (action: () => void) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setControlError('');
    try { await action(); } catch (error) {
      setControlError(error instanceof Error ? error.message : 'The reader could not complete the action.');
    } finally { pendingRef.current = false; setPending(false); }
  };
  const copy = async (epc: string) => {
    try {
      await navigator.clipboard.writeText(epc);
      setCopyError('');
      setCopied(epc);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(''), 1800);
    } catch { setCopyError('Copy unavailable. Select the EPC text and copy it manually.'); }
  };
  const toggleExcluded = (tag: Tag) => {
    if (excluded.has(tag.epc)) props.setExcludedEpcs(current => current.filter(epc => epc !== tag.epc));
    else {
      props.setExcludedSnapshots(current => ({ ...current, [tag.epc]: tag }));
      props.setExcludedEpcs(current => [...current, tag.epc]);
    }
  };
  const epcContent = (tag: Tag) => <div className="flex min-w-0 items-center gap-2">
    <span className={`select-text font-mono text-[13px] font-medium text-slate-800 ${mobile ? 'break-all' : 'truncate'}`} title={tag.epc}>{tag.epc}</span>
    <button className="shrink-0 rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-blue-600" onClick={() => void copy(tag.epc)} aria-label={`Copy EPC ${tag.epc}`}>{copied === tag.epc ? <Check size={14} /> : <Copy size={14} />}</button>
  </div>;
  const actions = (tag: Tag) => <div className="flex justify-end gap-1">
    <button className="text-action" onClick={() => props.onChooseTag(tag.epc)}>Find tag</button>
    <button className="text-action !text-slate-500" onClick={() => toggleExcluded(tag)}>{panel === 'live' ? 'Exclude' : 'Restore'}</button>
  </div>;
  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const tag = rows[index];
    const rssi = tag.lastRssi ?? tag.rssi;
    const signal = rssi == null ? '—' : `${rssi}${rssi < 0 ? ' dBm' : ''}`;
    if (mobile) return <div style={style} className="px-3 pb-3"><article className="rounded-lg border border-slate-200 p-3">
      {epcContent(tag)}
      <div className="mt-3 flex justify-between text-xs text-slate-500"><span>Signal <strong className="ml-1 text-slate-700">{signal}</strong></span><span>Reads <strong className="ml-1 text-slate-700">{count(tag.count)}</strong></span></div>
      <div className="mt-2 border-t border-slate-100 pt-1">{actions(tag)}</div>
    </article></div>;
    return <div style={style} className="scan-table-row bg-white hover:bg-slate-50" role="row">
      <span role="cell" className="text-xs text-slate-400">{index + 1}</span>
      <div role="cell">{epcContent(tag)}</div>
      <span role="cell" className="font-mono text-xs text-slate-600">{signal}</span>
      <span role="cell" className="font-mono text-slate-700">{count(tag.count)}</span>
      <div role="cell">{actions(tag)}</div>
    </div>;
  };

  return <div className="page-content scan-page">
    <PageHeader title="Scan tags" subtitle="Start a live scan, then monitor every detected EPC in the inventory below." meta={<span className={`status-pill ${props.isScanning ? 'online' : ''}`}><span className="status-dot" />{props.isBatchSaving ? 'Saving' : batch ? 'Batch scanning' : live ? 'Scanning' : 'Ready to scan'}</span>} actions={<button className="text-action" onClick={() => setShowGuide(!showGuide)} aria-expanded={showGuide} aria-controls="scan-guide">{showGuide ? 'Hide quick guide' : 'Quick guide'}</button>} />
    {showGuide && <ol id="scan-guide" className="guide-strip shrink-0" aria-label="Getting started">
      {[
        ['Connect the reader', 'Power on NHR-10, then select Connect device.'],
        ['Start a scan', 'Point the reader toward your tags and start scanning.'],
        ['Use the results', 'Choose Find tag to locate an item by its signal.'],
      ].map(([title, detail], index) => <li key={title} className={`guide-step ${index < (props.isConnected ? props.tags.length ? 2 : 1 : 0) ? 'done' : index === (props.isConnected ? props.tags.length ? 2 : 1 : 0) ? 'current' : ''}`}>
        <span className="guide-number">{index + 1}</span><div><p className="text-sm font-medium text-slate-800">{title}</p><p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p></div>
      </li>)}
    </ol>}
    <section className="shrink-0 space-y-3" aria-label="Scan controls">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:px-4">
        <div className="flex flex-wrap gap-2">
          <Button variant={live ? 'danger' : 'primary'} disabled={locked || batch} onClick={() => void run(live ? props.onStopScan : props.onStartScan)}>
            {live ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}{live ? 'Stop scan' : 'Start scan'}
          </Button>
          <Button variant={batch ? 'danger' : 'outline'} disabled={locked || live} onClick={() => void run(batch ? props.onStopBatch : props.onStartBatch)}>{batch ? 'Stop & save batch' : 'Scan to device'}</Button>
        </div>
        <span className="text-xs text-slate-500">Elapsed <span className="ml-2 font-mono text-sm text-slate-800">{duration(props.scanStartedAt, props.isScanning ? now : props.scanStoppedAt)}</span></span>
      </div>
      {controlError && <p role="alert" className="text-sm text-red-700">{controlError}</p>}
      {(batch || props.isBatchSaving || props.batchSaveInfo.state === 'saved' || props.batchSaveInfo.state === 'save_failed') && <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900" role="status">
        {props.isBatchSaving ? `Saving on device · ${Math.round(props.batchSaveInfo.progress)}%` : props.batchSaveInfo.state === 'save_failed' ? 'The device could not save this batch. Check Diagnostics before starting again.' : batch ? 'Tags are being stored on the reader. Stop & save batch, then open Saved data to download them.' : 'Batch saved. Open Saved data to download and export your tags.'}
        {!props.isBatchSaving && !batch && props.batchSaveInfo.state === 'saved' && <button className="text-action ml-2" onClick={props.onOpenStorage}>Open saved data →</button>}
      </div>}
    </section>
    <section className="flex min-h-[460px] flex-1 flex-col rounded-xl border border-blue-200 bg-white shadow-[0_4px_18px_rgba(37,99,235,0.06)]" aria-label="Tag results">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="eyebrow !text-blue-600">Primary workspace</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">{panel === 'live' ? 'Live EPC inventory' : 'Excluded EPCs'}</h2>
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold tabular-nums text-blue-700">{rows.length}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex rounded-lg bg-slate-100 p-1" role="group" aria-label="Result view">
            <button className={`rounded-md px-3 py-1.5 text-xs ${panel === 'live' ? 'bg-white font-semibold text-slate-900 shadow-sm' : 'text-slate-500'}`} onClick={() => setPanel('live')} aria-pressed={panel === 'live'}>Live <span className="ml-1 text-slate-400">{liveTags.length}</span></button>
            <button className={`rounded-md px-3 py-1.5 text-xs ${panel === 'excluded' ? 'bg-white font-semibold text-slate-900 shadow-sm' : 'text-slate-500'}`} onClick={() => setPanel('excluded')} aria-pressed={panel === 'excluded'}>Excluded <span className="ml-1 text-slate-400">{excludedTags.length}</span></button>
          </div>
          <button className="text-action !text-slate-500 disabled:opacity-40" disabled={panel === 'live' ? !props.tags.length : !excludedTags.length} onClick={panel === 'live' ? props.onClear : () => { props.setExcludedEpcs([]); props.setExcludedSnapshots({}); }}>{panel === 'live' ? 'Clear results' : 'Restore all'}</button>
        </div>
      </div>
      <div className="scan-metrics-compact shrink-0" aria-label="Scan statistics">
        {[
          ['Tags in view', count(liveTags.length)], ['Total reads', count(props.stats.totalReads)], ['Reads / second', Number.isFinite(props.stats.readsPerSecond) ? props.stats.readsPerSecond.toFixed(0) : '0'], ['Excluded tags', count(props.excludedEpcs.length)],
        ].map(([label, value], i) => <div className="scan-metric-compact" key={label}><p className="text-[11px] text-slate-500">{label}</p><p className={`mt-0.5 text-lg font-semibold leading-none tabular-nums ${i === 0 ? 'text-blue-600' : 'text-slate-800'}`}>{value}</p></div>)}
      </div>
      {copyError && <p className="px-4 py-2 text-sm text-amber-700" role="status">{copyError}</p>}
      {rows.length === 0 ? <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center px-6 py-8 text-center">
        <span className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 text-sm font-medium text-slate-400">{panel === 'excluded' ? '—' : '01'}</span>
        <h2 className="text-base font-semibold text-slate-800">{panel === 'excluded' ? 'No excluded tags' : !props.isConnected ? 'Your reader is ready to connect' : batch ? 'Batch scan is running on the reader' : live ? 'Listening for tags…' : 'Ready for your first scan'}</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{panel === 'excluded' ? 'Use Exclude on a tag to hide it from the live list. You can restore it here.' : !supported ? 'Open this page in Chrome or Edge with Web Bluetooth enabled. Use HTTPS or localhost to connect your reader.' : !props.isConnected ? 'Power on your NHR-10 and enable Bluetooth, then choose your reader from the device list.' : batch ? 'Stop and save the batch, then retrieve it from Saved data.' : live ? 'Bring a tag into the antenna field. Results will appear here automatically.' : 'Select Start scan. You can copy an EPC or choose Find tag from the results.'}</p>
        {!props.isConnected && supported && panel === 'live' && <Button className="mt-5" disabled={props.isConnecting} onClick={props.onConnect}>{props.isConnecting ? 'Connecting…' : 'Connect device'}</Button>}
      </div> : <div className="flex min-h-[300px] flex-1 flex-col overflow-x-auto" role={mobile ? undefined : 'table'} aria-label="RFID tags" aria-rowcount={mobile ? undefined : rows.length + 1}>
        {!mobile && <div className="scan-table-row h-10 shrink-0 bg-slate-50 text-xs text-slate-500" role="row">{['#', 'EPC', 'Signal', 'Reads', ''].map((text, i) => <span key={i} role="columnheader">{text || 'Actions'}</span>)}</div>}
        <div className="min-h-[260px] flex-1 pt-2 sm:pt-0"><AutoSizer>{({ height, width }) => <List height={height} width={mobile ? width : Math.max(720, width)} itemCount={rows.length} itemSize={mobile ? 170 : 52} itemKey={index => rows[index].epc}>{Row}</List>}</AutoSizer></div>
      </div>}
    </section>
    <section className="shrink-0" aria-label="Optional scan settings">
      <details className="group rounded-lg border border-slate-200 bg-white">
        <summary className="flex items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-slate-600"><span>Scan options <span className="ml-2 text-xs font-normal text-slate-400">RF profiles & display filters</span></span><span className="flex items-center gap-2"><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Optional</span><ChevronDown size={16} className="transition-transform group-open:rotate-180" aria-hidden="true" /></span></summary>
        <div className="space-y-4 border-t border-slate-100 p-4">
          <fieldset disabled={locked || props.isScanning}>
            <legend className="mb-2 text-sm font-medium">RF profile</legend>
            <div className="grid gap-2 md:grid-cols-3">{PRESETS.map(p => <button type="button" key={p.mode} aria-label={p.label} aria-describedby={`profile-${p.mode}-purpose`} aria-pressed={preset === p.mode}
              className={`rounded-lg border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${preset === p.mode ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white enabled:hover:border-blue-300 enabled:hover:bg-slate-50'}`}
              onClick={() => void run(async () => { await props.onApplyPreset(p.mode); setPreset(p.mode); })}>
              <span className={`block text-sm font-semibold ${preset === p.mode ? 'text-blue-700' : 'text-slate-800'}`}>{p.label}</span>
              <span id={`profile-${p.mode}-purpose`} className="mt-1 block text-xs font-normal leading-5 text-slate-500">{p.purpose}</span>
            </button>)}</div>
            <p className="mt-2 text-xs leading-5 text-slate-500">{preset ? `${PRESETS.find(p => p.mode === preset)!.label} · ${PRESETS.find(p => p.mode === preset)!.detail}` : 'Select a profile to apply it. Until then, the current device settings are used.'}</p>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
            <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={props.removeStaleTags} onChange={e => props.onChangeRemoveStaleTags(e.target.checked)} />Hide tags not seen for</label>
            <input aria-label="Hide stale tags after milliseconds" className="w-24 rounded-md border border-slate-200 px-3 py-2 text-sm" type="number" min={100} max={60000} step={100} disabled={!props.removeStaleTags} value={timeoutInput} onChange={e => setTimeoutInput(e.target.value)} onBlur={() => { const value = Math.max(100, Math.min(60000, Number(timeoutInput) || props.staleRemoveMs)); props.onChangeStaleRemoveMs(value); setTimeoutInput(String(value)); }} /><span className="text-xs text-slate-500">ms (100–60,000)</span>
          </div>
          <p className="text-xs leading-5 text-slate-500">Start scan displays tags live. Scan to device records a batch in the reader for later download. Each new scan starts a new result list.</p>
        </div>
      </details>
    </section>
  </div>;
};

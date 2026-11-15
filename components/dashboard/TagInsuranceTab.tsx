import React, { useState } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { TagInsuranceController } from '../../hooks/useTagInsurance';
import { defaultInsuranceConfig, insuranceErrorReason, insuranceInstruction, insuranceTitles, insuranceWindowCount, validInsuranceConfig } from '../../utils/tagInsurance';
import { Button } from '../ui/Button';

type Props = {
  controller: TagInsuranceController; connected: boolean; busy: boolean;
};
export function TagInsuranceTab({ controller: c, connected, busy }: Props) {
  const [draft, setDraft] = useState(c.config);
  const v = c.snapshot;
  const enabled = v?.enabled === true;
  const nextConfig = c.durationSupported === false ? { ...draft, dur: defaultInsuranceConfig.dur } : draft;
  const displayed = enabled ? { ...c.config, dur: v.duration } : nextConfig;
  const windows = insuranceWindowCount(displayed.dur);
  const thresholdFields = [
    { key: 'dur', label: 'Remain Time (ms)', min: 1000, max: 30000,
      help: 'Total measurement time from inventory start, not from the first tag. Default 3000 ms; RF checks and stop/drain are outside this window.' },
    { key: 'min', label: 'Minimum reads', min: 1, max: 10000,
      help: 'Total valid reports of the same EPC during the whole test. 30 means at least 30 reports, not 30 reads per second.' },
    { key: 'bins', label: 'Active 250 ms windows', min: 1, max: windows,
      help: `${displayed.dur} ms gives ${windows} windows. A window counts once when it contains a read; the final window may be shorter than 250 ms. Recalibrate this threshold when changing time.` },
    { key: 'gap', label: 'Longest silence (ms)', min: 100, max: displayed.dur,
      help: 'Maximum allowed time without a read, including start to first read and last read to the end. 500 allows no silence longer than half a second.' },
  ] as const;
  const finishing = v?.busy && v.state !== 'running' && v.state !== 'preparing' && v.state !== 'more';
  const warning = v?.state === 'more' || v?.state === 'no_read';
  const failed = v?.state === 'check' || v?.state === 'error';
  const disabled = !connected || busy || c.pending || !v || v.busy;
  return <section className="h-full overflow-y-auto p-5 sm:p-8 space-y-6" aria-label="Tag Insurance">
    <div><h1 className="text-2xl font-semibold">Tag Insurance</h1>
      <p className="mt-2 text-sm text-slate-600">Set the test criteria, enable the mode, then use the reader trigger. RF parameters use the current configuration from Device settings.</p></div>
    <div className="flex flex-wrap gap-3">
      <Button disabled={disabled || (!enabled && !validInsuranceConfig(nextConfig))} onClick={() => void c.setMode(!enabled, enabled ? c.config : nextConfig)}>
        {c.pending ? 'Waiting for device…' : enabled ? 'Stop Tag Insurance' : 'Enable with current RF settings'}
      </Button>
      <Button variant="outline" disabled={!connected || c.pending} onClick={() => void c.query()}>Refresh status</Button>
    </div>
    {c.error && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{c.error}</p>}
    {!connected && <p className="text-sm text-slate-600">Connect to configure the reader or retrieve its result. An enabled mode continues without Bluetooth; power off to return to normal scanning.</p>}
    {enabled && <div className={`rounded-2xl border p-5 ${v.state === 'ok' && !v.busy ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'}`}>
      <p className="text-xs uppercase tracking-wide text-slate-500">Test {v.id}</p>
      <h2 role="status" className="mt-2 flex items-center gap-3 text-2xl font-semibold">
        {!finishing && v.state === 'ok' && <CircleCheck aria-hidden="true" className="h-8 w-8 text-emerald-600" />}
        {!finishing && (warning || failed) && <TriangleAlert aria-hidden="true" className={`h-8 w-8 ${warning ? 'text-amber-500' : 'text-red-600'}`} />}
        {finishing ? 'Finishing…' : insuranceTitles[v.state]}
      </h2>
      {v.state === 'error' && <p className="mt-2 text-sm font-medium text-red-700">{insuranceErrorReason(v)} · r={v.reason}</p>}
      <p className="my-3 font-mono text-3xl tracking-widest">{v.epc.slice(-6) || '------'}</p>
      <progress aria-label="Test elapsed time" className="mt-4 w-full" max={v.duration} value={v.elapsed} />
      <p className="mt-2 text-sm">{v.count} reads · {v.elapsed} / {v.duration} ms</p>
      <p className="mt-4 text-sm leading-6">{insuranceInstruction(v)}</p>
      <details className="mt-4 text-xs text-slate-500"><summary className="cursor-pointer">Measurement details</summary>
        <p className="mt-2 break-all font-mono">{v.epc || 'No EPC'}</p>
        <p className="mt-2">{v.bins}/{insuranceWindowCount(v.duration)} occupied time bins · maximum gap {v.gap} ms</p>
      </details>
    </div>}
    <section aria-label="Test time and pass criteria" className="rounded-2xl border border-slate-200 p-5">
      <h2 className="font-semibold">Test time and pass criteria</h2>
      <fieldset disabled={!connected || enabled || c.pending || busy} className="mt-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {thresholdFields.map(({ key, label, min, max, help }) =>
            <div key={key} className="text-sm"><label htmlFor={`ti-${key}`}>{label}</label>
              <input id={`ti-${key}`} aria-describedby={`ti-${key}-help`} type="number" min={min} max={max} step={1} value={displayed[key]}
                disabled={key === 'dur' && c.durationSupported !== true}
                onChange={e => setDraft(previous => ({ ...previous, [key]: Number(e.target.value) }))} className="mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:bg-slate-100" />
              <p id={`ti-${key}-help`} className="mt-2 text-xs leading-5 text-slate-500">{help}</p>
            </div>)}
        </div>
        {c.durationSupported === false && <p className="mt-3 text-sm text-amber-700">This firmware uses a fixed 3000 ms window. Update firmware to configure Remain Time.</p>}
        {!validInsuranceConfig(displayed) && <p role="alert" className="mt-3 text-sm text-red-700">Use whole numbers: time 1000–30000 ms, reads 1–10000, windows 1–{windows}, silence 100–{displayed.dur} ms. Adjust the thresholds to fit the chosen time.</p>}
        <p className="mt-4 text-xs leading-5 text-slate-500">Exactly one EPC and all three thresholds must pass over the configured time, including the first and last no-read gaps. Initial thresholds are provisional. Each trigger starts a new independent test; the device does not decide when to replace a tag.</p>
      </fieldset>
    </section>
  </section>;
}

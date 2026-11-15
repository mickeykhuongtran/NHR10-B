import React, { useState } from 'react';
import { TagInsuranceController } from '../../hooks/useTagInsurance';
import { defaultInsuranceConfig, insuranceInstruction, insuranceTitles, validInsuranceConfig } from '../../utils/tagInsurance';
import { Button } from '../ui/Button';

export function TagInsuranceTab({ controller: c, connected, busy }: { controller: TagInsuranceController; connected: boolean; busy: boolean }) {
  const [draft, setDraft] = useState(defaultInsuranceConfig);
  const v = c.snapshot;
  const enabled = v?.enabled === true;
  const disabled = !connected || busy || c.pending || !v || v.busy;
  return <section className="h-full overflow-y-auto p-5 sm:p-8 space-y-6" aria-label="Tag Insurance">
    <div><p className="eyebrow">Single product check</p><h1 className="mt-2 text-2xl font-semibold">Tag Insurance</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">Activate here, then work with the trigger and screen on the reader. The reader keeps testing if Bluetooth disconnects. Restarting the reader returns it to normal scanning.</p></div>
    <div className="flex flex-wrap gap-3">
      <Button disabled={disabled || !validInsuranceConfig(draft)} onClick={() => void c.setMode(!enabled, draft)}>
        {c.pending ? 'Waiting for RF confirmation…' : enabled ? 'Normal scanning' : 'Enable Tag Insurance'}
      </Button>
      <Button variant="outline" disabled={!connected || c.pending} onClick={() => void c.query()}>Query device status</Button>
    </div>
    {c.error && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{c.error}</p>}
    {!connected && <p className="text-sm text-slate-600">Connect to activate the mode or retrieve the current result.</p>}
    <div className={`rounded-2xl border p-5 ${v?.state === 'ok' ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'}`}>
      <p className="text-xs uppercase tracking-wide text-slate-500">{enabled ? `Test ${v.id} · Attempt ${v.attempt}/2` : 'Device mode'}</p>
      <h2 role="status" className="mt-2 text-2xl font-semibold">{v ? insuranceTitles[v.state] : connected ? 'Querying device…' : 'Disconnected'}</h2>
      {enabled && <>
        <p className="my-3 font-mono text-3xl tracking-widest">{v.epc.slice(-6) || '------'}</p>
        <p className="break-all font-mono text-xs text-slate-500">{v.epc || 'No EPC detected yet'}</p>
        <progress aria-label="Test elapsed time" className="mt-4 w-full" max={3000} value={v.elapsed} />
        <p className="mt-2 text-sm">{v.count} reads · {(v.elapsed / 1000).toFixed(1)} / 3.0 seconds · {v.bins}/12 occupied time bins · max gap {v.gap} ms</p>
      </>}
      {v && <p className="mt-4 text-sm leading-6">{insuranceInstruction(v)}</p>}
    </div>
    <fieldset disabled={enabled || c.pending || busy} className="rounded-2xl border border-slate-200 p-5">
      <legend className="px-2 font-medium">Trial thresholds — calibrate with your samples</legend>
      <p className="mb-4 text-sm text-slate-600">Fixed preset: 10 dBm · Quick profile 11 (640 kHz, FM0) · S0 · Q2 · TagFocus off. Frequency is unchanged. Use the same marked distance and antenna orientation for all products.</p>
      <div className="grid gap-4 sm:grid-cols-3">
        {([['min', 'Minimum reads', 1, 10000], ['bins', 'Occupied 250 ms bins', 1, 12], ['gap', 'Maximum gap (ms)', 100, 3000]] as const).map(([key, label, min, max]) =>
          <label key={key} className="text-sm">{label}<input type="number" min={min} max={max} step={1} value={enabled ? c.config[key] : draft[key]}
            onChange={e => setDraft(previous => ({ ...previous, [key]: Number(e.target.value) }))} className="mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:bg-slate-100" /></label>)}
      </div>
      <p className="mt-4 text-xs leading-5 text-slate-500">All three thresholds must pass across the full 3 seconds, including the initial and final no-read gaps. Initial values are provisional, not a calibrated tag-quality standard. Do not move closer to make a failed product pass. No EPC is known in advance; isolation is required.</p>
    </fieldset>
  </section>;
}

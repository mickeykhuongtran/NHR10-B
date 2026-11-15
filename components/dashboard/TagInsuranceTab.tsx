import React, { useState } from 'react';
import { TagInsuranceController } from '../../hooks/useTagInsurance';
import { SettingsActivity } from '../../hooks/useSettingsActions';
import { Settings } from '../../types';
import { SettingsRequest } from '../../utils/settingsProtocol';
import { defaultInsuranceConfig, insuranceInstruction, insuranceTitles, validInsuranceConfig } from '../../utils/tagInsurance';
import { Button } from '../ui/Button';
import { SettingsTab } from './SettingsTab';

type Props = {
  controller: TagInsuranceController; connected: boolean; busy: boolean;
  settings: Settings; settingsActivity: SettingsActivity | null;
  onSettingsAction: (request: SettingsRequest) => void | Promise<void>;
};
export function TagInsuranceTab({ controller: c, connected, busy, settings, settingsActivity, onSettingsAction }: Props) {
  const [draft, setDraft] = useState(defaultInsuranceConfig);
  const v = c.snapshot;
  const enabled = v?.enabled === true;
  const disabled = !connected || busy || c.pending || !v || v.busy;
  return <section className="h-full overflow-y-auto p-5 sm:p-8 space-y-6" aria-label="Tag Insurance">
    <div><h1 className="text-2xl font-semibold">Tag Insurance</h1>
      <p className="mt-2 text-sm text-slate-600">Set up your reference test, enable the mode, then use the reader trigger. One press runs a 3-second test; press again to cancel.</p></div>
    <div className="flex flex-wrap gap-3">
      <Button disabled={disabled || (!enabled && !validInsuranceConfig(draft))} onClick={() => void c.setMode(!enabled, enabled ? c.config : draft)}>
        {c.pending ? 'Waiting for device…' : enabled ? 'Stop Tag Insurance' : 'Enable with current RF settings'}
      </Button>
      <Button variant="outline" disabled={!connected || c.pending} onClick={() => void c.query()}>Refresh status</Button>
    </div>
    {c.error && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{c.error}</p>}
    {!connected && <p className="text-sm text-slate-600">Connect to configure the reader or retrieve its result. An enabled mode continues without Bluetooth; power off to return to normal scanning.</p>}
    {enabled && <div className={`rounded-2xl border p-5 ${v.state === 'ok' && !v.busy ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'}`}>
      <p className="text-xs uppercase tracking-wide text-slate-500">Test {v.id}</p>
      <h2 role="status" className="mt-2 text-2xl font-semibold">{v.busy && v.state !== 'running' && v.state !== 'preparing' ? 'Finishing…' : insuranceTitles[v.state]}</h2>
      <p className="my-3 font-mono text-3xl tracking-widest">{v.epc.slice(-6) || '------'}</p>
      <progress aria-label="Test elapsed time" className="mt-4 w-full" max={3000} value={v.elapsed} />
      <p className="mt-2 text-sm">{v.count} reads · {(v.elapsed / 1000).toFixed(1)} / 3.0 s</p>
      <p className="mt-4 text-sm leading-6">{insuranceInstruction(v)}</p>
      <details className="mt-4 text-xs text-slate-500"><summary className="cursor-pointer">Measurement details</summary>
        <p className="mt-2 break-all font-mono">{v.epc || 'No EPC'}</p>
        <p className="mt-2">{v.bins}/12 occupied time bins · maximum gap {v.gap} ms</p>
      </details>
    </div>}
    <section aria-label="Insurance RF setup" className="rounded-2xl border border-slate-200 p-5 space-y-4">
      <h2 className="font-semibold">RF setup</h2>
      <p className="text-sm text-slate-600">{enabled ? 'Stop Tag Insurance above to change settings, then enable it again.' : 'Read or apply the values below before enabling. Enabling and disabling this mode do not change RF settings.'}</p>
      <p className="text-xs text-slate-500">Power, profile, session, Q, Tag Focus and query timing are your test conditions. Calibrate the thresholds with known good and poor tags at the same position. EPC filters must be cleared so a second tag cannot be hidden.</p>
      <SettingsTab embedded isConnected={connected} isBusy={busy || c.locked} settings={settings}
        activity={settingsActivity} onAction={onSettingsAction} />
    </section>
    <details className="rounded-2xl border border-slate-200 p-5">
      <summary className="cursor-pointer font-medium">Pass criteria</summary>
      <fieldset disabled={!connected || enabled || c.pending || busy} className="mt-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {([['min', 'Minimum reads', 1, 10000], ['bins', 'Occupied 250 ms bins', 1, 12], ['gap', 'Maximum gap (ms)', 100, 3000]] as const).map(([key, label, min, max]) =>
            <label key={key} className="text-sm">{label}<input type="number" min={min} max={max} step={1} value={enabled ? c.config[key] : draft[key]}
              onChange={e => setDraft(previous => ({ ...previous, [key]: Number(e.target.value) }))} className="mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:bg-slate-100" /></label>)}
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-500">Exactly one EPC and all three thresholds must pass across 3 seconds, including the first and last no-read gaps. Initial thresholds are provisional. Each trigger starts a new independent test; the device does not decide when to replace a tag.</p>
      </fieldset>
    </details>
  </section>;
}

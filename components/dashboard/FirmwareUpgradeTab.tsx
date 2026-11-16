import React, { useState } from 'react';
import { ArrowRight, Bluetooth, CheckCircle2, Download, FileUp, Info, Loader2, ShieldCheck } from 'lucide-react';
import type { FirmwareUpdate } from '../../hooks/useFirmwareUpdate';
import { ConnectionStatus, Settings } from '../../types';
import { PageHeader } from './PageHeader';
import { Button } from '../ui/Button';

const sizeLabel = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
const timeLabel = (seconds: number | null) => seconds === null ? '—' : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
interface Props {
  firmware: FirmwareUpdate;
  status: ConnectionStatus;
  settings: Settings;
  operationBusy: boolean;
  insuranceBlocked?: boolean;
  onConnect(): void;
}

export function FirmwareUpgradeTab({ firmware, status, settings, operationBusy, insuranceBlocked = false, onConnect }: Props) {
  const [allowDowngrade, setAllowDowngrade] = useState(false);
  const [consent, setConsent] = useState(false);
  const { state, pkg, loading, packageError } = firmware;
  const supported = 'bluetooth' in navigator && window.isSecureContext;
  const review = state.stage === 'review';
  const terminal = ['failed', 'cancelled', 'confirmed'].includes(state.stage);
  const transferring = ['preparing', 'transferring', 'verifying', 'restarting'].includes(state.stage) && state.active;
  const installed = state.active || terminal ? state.info?.fw || settings.version : settings.version;
  const step = state.stage === 'confirmed' ? 3 : ['verifying', 'restarting'].includes(state.stage) ? 2 : state.active ? 1 : 0;
  const prepare = () => { setConsent(false); void firmware.prepare('ble', allowDowngrade); };

  return <div className="page-content">
    <PageHeader title="UPGRADE FIRMWARE" subtitle="Update your NHR-10 REV-B over Bluetooth. Choose a package, review the reader and confirm installation." />
    <div className="guide-strip" aria-label="Firmware update steps">
      {[['1', 'Choose firmware', 'Select a REV-B package.'], ['2', 'Review & install', 'Confirm the reader and version.'], ['3', 'Verify startup', 'Wait for the reader to restart.']].map(([number, title, detail], index) =>
        <div key={number} className={`guide-step ${step === index ? 'current' : ''}`}>
          <span className="guide-number">{number}</span><div><p className="text-sm font-medium text-slate-800">{title}</p><p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p></div>
        </div>)}
    </div>
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(270px,1fr)]">
      <div className="min-w-0 space-y-5">
        {terminal && <section role={state.stage === 'failed' ? 'alert' : 'status'} className={`rounded-xl border p-5 sm:p-6 ${state.stage === 'confirmed' ? 'border-emerald-200 bg-emerald-50' : state.stage === 'failed' ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'}`}>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">{state.stage === 'confirmed' ? <CheckCircle2 size={20} className="text-emerald-600" /> : <Info size={20} />}{state.stage === 'confirmed' ? 'Update confirmed' : state.stage === 'failed' ? 'Update needs attention' : 'Update cancelled'}</h2>
          <p className="mt-3 text-sm leading-6 text-slate-700">{state.message}</p>
          {state.info && <p className="mt-2 break-all text-xs text-slate-500">Last reported version: {state.info.fw} · {state.info.id}</p>}
          <Button className="mt-4" variant="outline" onClick={firmware.downloadDiagnostics}><Download size={15} />Download diagnostics</Button>
        </section>}

        {!state.active && <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6" aria-labelledby="firmware-package-title">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="firmware-package-title" className="text-base font-semibold text-slate-900">Firmware package</h2><span className="status-pill">NHR10-B · REV-B</span></div>
          <p className="mt-2 text-sm leading-6 text-slate-500">Choose a .nhrota file supplied for this reader by your firmware team.</p>
          {firmware.releaseConfigured && <div className="mt-5"><Button onClick={() => void firmware.loadRelease()} disabled={loading}><Download size={16} />Check approved release</Button></div>}
          <label htmlFor="ota-package" className="mt-5 block text-sm font-medium text-slate-700">
            <span className="mb-2 flex items-center gap-2"><FileUp size={16} />Local firmware package</span>
            <input id="ota-package" type="file" accept=".nhrota" disabled={loading}
              className="block w-full min-w-0 rounded-lg border border-slate-200 p-2 text-xs text-slate-500 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700"
              onChange={event => { const file = event.target.files?.[0]; if (file) void firmware.selectFile(file); event.target.value = ''; }} />
          </label>
          <p className="mt-3 text-xs leading-5 text-slate-500">Use a trusted package. The integrity check detects corruption but does not authenticate the publisher.</p>
          {loading && <p role="status" className="mt-4 flex items-center gap-2 text-sm text-blue-700"><Loader2 size={16} className="animate-spin" />Validating package…</p>}
          {packageError && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm leading-6 text-red-700">{packageError}</p>}
          {pkg && <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-800"><ShieldCheck size={17} />Package integrity verified</p>
            <p className="mt-2 break-all text-sm text-slate-700">{pkg.name}</p><p className="mt-1 text-xs text-slate-500">{pkg.version} · {sizeLabel(pkg.size)} · REV-B</p>
            {pkg.releaseNotes && <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{pkg.releaseNotes}</p>}
          </div>}
          <details className="mt-5 border-t border-slate-100 pt-4">
            <summary className="cursor-pointer text-xs font-medium text-slate-500">Engineering options</summary>
            <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-slate-500"><input className="mt-1" type="checkbox" checked={allowDowngrade} disabled={loading} onChange={event => setAllowDowngrade(event.target.checked)} />Allow an older local firmware version for engineering tests.</label>
          </details>
        </section>}

        {!state.active && <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6" aria-labelledby="ota-connection-title">
          <h2 id="ota-connection-title" className="flex items-center gap-2 text-base font-semibold text-slate-900"><Bluetooth size={18} className="text-blue-600" />Bluetooth connection</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">{supported ? 'Uses the reader already connected to this controller.' : 'Open this app over HTTPS or localhost in a browser with Web Bluetooth support.'}</p>
          {status !== 'connected' && <div className="mt-4"><Button variant="outline" onClick={onConnect} disabled={!supported || status === 'connecting'}>{status === 'connecting' ? 'Connecting…' : 'Connect reader'}</Button></div>}
          <div className="mt-5 border-t border-slate-100 pt-5">
            <Button onClick={prepare} disabled={!pkg || loading || operationBusy || insuranceBlocked || status !== 'connected' || !supported}>Prepare & review<ArrowRight size={16} /></Button>
            <p className="mt-3 text-xs leading-5 text-slate-500">{insuranceBlocked ? 'Turn off Tag Insurance and wait for its status before updating.' : operationBusy ? 'Stop scanning or finding, and finish saving, writing or downloading data first.' : 'Device controls pause during review and installation.'}</p>
          </div>
        </section>}

        {review && <section className="rounded-xl border border-blue-200 bg-white p-5 sm:p-6" aria-labelledby="ota-review-title">
          <h2 id="ota-review-title" className="text-lg font-semibold text-slate-900">Ready to install</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">Compatibility checked for <span className="break-all font-medium text-slate-700">{state.info?.id}</span>.</p>
          <div className="my-6 flex flex-wrap items-center gap-4"><span className="break-all text-xl font-semibold text-slate-500">{state.info?.fw}</span><ArrowRight size={20} className="shrink-0 text-slate-400" /><span className="break-all text-2xl font-semibold text-blue-600">{state.target}</span></div>
          <p className="text-sm text-slate-500">{sizeLabel(state.total)} · Bluetooth · {state.info?.hw}</p>
          <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-lg bg-slate-50 p-4 text-sm leading-6 text-slate-600"><input type="checkbox" className="mt-1.5 shrink-0" checked={consent} onChange={event => setConsent(event.target.checked)} />I confirm this firmware and reader. I will keep the reader powered and this page open until startup is confirmed.</label>
          <div className="mt-5 flex flex-wrap gap-3"><Button disabled={!consent} onClick={() => void firmware.install()}>Install firmware<ArrowRight size={16} /></Button><Button variant="outline" onClick={() => void firmware.cancel()} disabled={!state.cancellable}>Cancel</Button></div>
        </section>}

        {transferring && <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-7" aria-labelledby="ota-progress-title">
          <p className="eyebrow">Firmware update</p><h2 id="ota-progress-title" className="mt-3 flex items-center gap-2 text-lg font-semibold text-slate-900"><Loader2 size={19} className="shrink-0 animate-spin text-blue-600" />{state.message}</h2>
          <p className="mt-8 text-5xl font-semibold tabular-nums tracking-tight text-slate-900">{state.percent}<span className="ml-1 text-2xl text-slate-400">%</span></p>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="Firmware transfer" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.percent}><div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${state.percent}%` }} /></div>
          <div className="mt-4 flex flex-wrap justify-between gap-3 text-xs text-slate-500"><span>{sizeLabel(state.bytes)} / {sizeLabel(state.total)}</span><span>Elapsed {timeLabel(state.elapsed)} · Remaining {timeLabel(state.remaining)}</span></div>
          <p role="status" className="mt-6 text-sm leading-6 text-slate-600">{state.percent === 100 ? 'Transfer complete. Waiting for firmware verification and a successful startup.' : 'Keep the reader powered and this page in the foreground.'}</p>
          {state.cancellable && <Button variant="outline" className="mt-5" onClick={() => void firmware.cancel()}>Cancel update</Button>}
        </section>}
      </div>
      <aside className="min-w-0 space-y-5">
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6"><p className="eyebrow">Your reader</p><p className="mt-3 break-words text-lg font-semibold text-slate-900">{settings.deviceName || state.info?.product || 'NHR-10 REV-B'}</p><p className="mt-1 break-all text-xs text-slate-500">{state.info?.id || settings.deviceCanonicalId || 'Identity checked during preparation'}</p>
          <dl className="mt-5 space-y-4 text-sm"><div><dt className="text-slate-500">Installed firmware</dt><dd className="mt-1 break-all font-medium text-slate-800">{installed || 'Read during preparation'}</dd></div><div><dt className="text-slate-500">Target firmware</dt><dd className="mt-1 break-all font-medium text-slate-800">{state.active ? state.target : pkg?.version || 'Select a package'}</dd></div></dl>
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6"><p className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Info size={17} className="text-slate-400" />Before you update</p>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-500"><li>Finish scanning, save your batch and turn off Tag Insurance.</li><li>Charge the battery before starting and keep the reader powered.</li><li>Keep this page open until the same reader returns and confirms startup.</li></ul>
          <p className="mt-4 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-500">Cancel is available until verification begins. Readers without BLE update support need an initial firmware installation through the programming connection.</p>
        </section>
      </aside>
    </div>
  </div>;
}

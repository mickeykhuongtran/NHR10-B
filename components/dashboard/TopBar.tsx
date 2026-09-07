import React from 'react';
import { BatteryCharging, BatteryMedium } from 'lucide-react';
import { Button } from '../ui/Button';
import { ConnectionStatus, Settings } from '../../types';
import { isBatteryCharging } from '../../utils/battery';
import { formatDeviceDisplayName } from '../../utils/deviceIdentity';
import logoUrl from '../../logo/nws_logo.png';

interface TopBarProps {
  status: ConnectionStatus;
  settings: Settings;
  onConnect: () => void;
  onDisconnect: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ status, settings, onConnect, onDisconnect }) => {
  const connected = status === 'connected';
  const battery = settings.batterySnapshot;
  const fresh = battery && !battery.stale;
  const charging = fresh && isBatteryCharging(battery.chargePhase);
  const BatteryIcon = charging ? BatteryCharging : BatteryMedium;
  const name = settings.deviceName || formatDeviceDisplayName('', undefined, settings.deviceInfo) || 'NHR-10';
  const statusLabel = connected ? 'Connected' : status === 'connecting' ? 'Connecting…' : status === 'error' ? 'Connection failed' : 'Not connected';
  const supported = typeof navigator !== 'undefined' && 'bluetooth' in navigator && window.isSecureContext;

  return (
    <header className="z-30 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:px-7" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
      <div className="flex min-w-0 items-center gap-4">
        <img src={logoUrl} alt="Nextwaves" className="h-8 w-auto max-w-[120px] object-contain" />
        <div className="border-l border-slate-200 pl-4">
          <p className="text-sm font-semibold tracking-tight text-slate-900">NHR-10 <span className="font-normal text-slate-500">Controller</span></p>
          <p className="mt-0.5 text-xs text-slate-400">UHF RFID · Device demo</p>
        </div>
      </div>
      <div className="flex w-full flex-wrap items-center justify-between gap-3 sm:w-auto sm:justify-end">
        {connected && <span className="hidden max-w-[180px] truncate text-sm text-slate-600 md:block" title={settings.deviceCanonicalId}>{name}</span>}
        <span className={`status-pill ${connected ? 'online' : ''}`}><span className="status-dot" />{statusLabel}</span>
        {connected && (
          <span className={`inline-flex items-center gap-1.5 text-sm ${fresh && battery.protectionState !== 'normal' ? 'text-red-600' : 'text-slate-500'}`} title={battery ? `Relative voltage gauge · ${battery.voltageMv} mV · ${battery.chargePhase ?? 'Charge unknown'}${battery.stale ? ' · Stale reading' : ''}` : 'Battery reading unavailable'}>
            <BatteryIcon size={17} />{fresh ? `${battery.visualPercent}%` : '—'}
          </span>
        )}
        <Button variant={connected ? 'outline' : 'primary'} size="sm" onClick={connected ? onDisconnect : onConnect} disabled={status === 'connecting' || (!connected && !supported)} title={!supported ? 'Use a browser with Web Bluetooth over HTTPS or localhost.' : undefined}>
          {connected ? 'Disconnect' : status === 'connecting' ? 'Connecting…' : status === 'error' ? 'Try again' : 'Connect device'}
        </Button>
      </div>
    </header>
  );
};

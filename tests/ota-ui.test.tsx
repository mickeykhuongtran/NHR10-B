import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { FirmwareUpgradeTab } from '../components/dashboard/FirmwareUpgradeTab';
import { FirmwareUpdate } from '../hooks/useFirmwareUpdate';
import { initialUpdateState } from '../services/firmwareUpdateService';
import { testInfo } from './ota-fixtures';
let container: HTMLDivElement, root: ReturnType<typeof createRoot>, firmware: FirmwareUpdate;
const settings: any = { version: testInfo.fw, deviceCanonicalId: testInfo.id, deviceName: 'NHR10 Reader' };
const render = () => act(() => root.render(<FirmwareUpgradeTab firmware={firmware} status={firmware.state.active ? 'updating' : 'connected'} settings={settings} operationBusy={false} onConnect={vi.fn()} />));
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  firmware = { state: { ...initialUpdateState }, pkg: null, loading: false, packageError: '', releaseConfigured: false, isActive: vi.fn(), clearPackage: vi.fn(), selectFile: vi.fn(), loadRelease: vi.fn(), prepare: vi.fn(), install: vi.fn(), cancel: vi.fn(), downloadDiagnostics: vi.fn() };
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const button = (name: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.includes(name))!;
it('offers local REV-B packages directly and only Bluetooth transport', () => {
  render(); expect(container.querySelector('h1')?.textContent).toBe('UPGRADE FIRMWARE');
  expect(container.querySelector('input[type=file]')?.getAttribute('accept')).toBe('.nhrota');
  expect(container.textContent).toContain('NHR10-B'); expect(container.textContent).not.toContain('REV-C');
  expect(container.textContent).not.toContain('USB'); expect(container.querySelector('[role=radiogroup]')).toBeNull();
  expect(button('Prepare & review').disabled).toBe(true);
  expect(container.textContent).toContain('does not authenticate');
});
it('blocks preparation while Tag Insurance owns the reader', () => {
  firmware.pkg = { version: '1.2.0-dev.2', name: 'test.nhrota', size: 901 } as any;
  act(() => root.render(<FirmwareUpgradeTab firmware={firmware} status="connected" settings={settings} operationBusy={false} insuranceBlocked onConnect={vi.fn()} />));
  expect(button('Prepare & review').disabled).toBe(true);
  expect(container.textContent).toContain('Turn off Tag Insurance');
});
it('requires explicit consent after preparation before enabling Install', () => {
  firmware.state = { ...initialUpdateState, stage: 'review', active: true, cancellable: true, info: testInfo, target: '1.2.0-dev.2', total: 901 };
  render(); expect(button('Install firmware').disabled).toBe(true);
  act(() => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  act(() => button('Install firmware').click()); expect(firmware.install).toHaveBeenCalledOnce();
});
it('does not call 100% success or offer Cancel during verification and restart', () => {
  for (const stage of ['verifying', 'restarting'] as const) {
    firmware.state = { ...initialUpdateState, stage, active: true, percent: 100, bytes: 901, total: 901, message: stage };
    render(); expect(container.textContent).not.toContain('Update confirmed'); expect(button('Cancel')).toBeUndefined();
    expect(container.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('100');
  }
});

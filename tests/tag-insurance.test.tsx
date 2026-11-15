import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTagInsurance, TagInsuranceController } from '../hooks/useTagInsurance';
import { ConnectionStatus, Settings } from '../types';
import { TagInsuranceTab } from '../components/dashboard/TagInsuranceTab';
import { defaultInsuranceConfig, insuranceInstruction, parseInsuranceSnapshot, validInsuranceConfig } from '../utils/tagInsurance';
const ble = vi.hoisted(() => ({ sendCommand: vi.fn() }));
vi.mock('../services/bleService', () => ({ bleService: ble }));
let controller: TagInsuranceController;
let root: Root;
let container: HTMLDivElement;
const settings: Settings = {
  power: 24, buzzer: true, tagFocus: true, fastTid: false, linkProfile: 5185,
  linkProfileFormat: 2, linkProfileConfirmed: true, qValue: 7, session: 255,
  scanParams: { interval: 30, dwell: 2, count: 0, append: 0 },
  version: '', temperature: null, batterySnapshot: null, deviceInfo: '', deviceName: '', deviceCanonicalId: '',
};
const off = { cmd: 'TI', on: 0, s: 'off', id: 0, a: 0, e: '', n: 0, t: 0, b: 0, g: 0, r: 0, z: 0 };
const ready = { ...off, on: 1, s: 'ready', a: 1 };
function Harness({ status = 'connected', revision = 1 }: { status?: ConnectionStatus; revision?: number }) {
  controller = useTagInsurance(status, revision); return null;
}
const rx = (data: object) => act(() => { controller.handleDataReceived(data as Record<string, unknown>); });
beforeEach(() => {
  vi.useFakeTimers(); ble.sendCommand.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div'); root = createRoot(container); act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it('keeps RF controls locked until device mode is known', () => {
  expect(ble.sendCommand).toHaveBeenCalledWith({ cmd: 'GTI' });
  expect(controller.isLocked()).toBe(true);
  rx(off); expect(controller.isLocked()).toBe(false);
});
it('waits for the mode result, not the Bluetooth write promise', async () => {
  rx(off);
  await act(async () => controller.setMode(true, defaultInsuranceConfig));
  expect(controller.pending).toBe(true); expect(controller.isLocked()).toBe(true);
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'TI', val: 1, ...defaultInsuranceConfig });
  rx(ready); expect(controller.pending).toBe(false); expect(controller.snapshot?.enabled).toBe(true);
  await act(async () => controller.setMode(false, defaultInsuranceConfig));
  expect(controller.isLocked()).toBe(true);
  rx(off); expect(controller.isLocked()).toBe(false);
});
it('does not infer normal mode when activation times out', async () => {
  rx(off); await act(async () => controller.setMode(true, defaultInsuranceConfig));
  await act(async () => vi.advanceTimersByTimeAsync(45000));
  expect(controller.snapshot).toBeNull(); expect(controller.isLocked()).toBe(true);
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GTI' });
  rx(ready); expect(controller.snapshot?.enabled).toBe(true);
});
it('reconnects to an autonomous test and recovers the retained final result', async () => {
  rx(ready); act(() => root.render(<Harness status="disconnected" />));
  expect(controller.snapshot).toBeNull();
  act(() => root.render(<Harness revision={2} />));
  expect(controller.isLocked()).toBe(true);
  rx({ ...ready, s: 'running', id: 12, n: 20, t: 1500 });
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GTI' });
  rx({ ...ready, s: 'ok', id: 12, n: 100, t: 3000, b: 12, g: 50 });
  expect(controller.snapshot?.state).toBe('ok');
  expect(ble.sendCommand.mock.calls.every(([arg]) => arg.cmd === 'GTI')).toBe(true);
});
it('keeps a failed mode change visible and blocks controls until status is queried', async () => {
  rx(off); await act(async () => controller.setMode(true, defaultInsuranceConfig));
  rx({ cmd: 'TI', status: 'err', error: 'setup_or_recovery' });
  expect(controller.snapshot).toBeNull(); expect(controller.isLocked()).toBe(true);
  rx(off); expect(controller.error).toContain('setup_or_recovery');
});
it('validates all metrics and preserves full EPC identity in the protocol', () => {
  expect(parseInsuranceSnapshot({ ...ready, e: 'AABBCCDD11223344', n: 2 })?.epc).toBe('AABBCCDD11223344');
  expect(parseInsuranceSnapshot({ ...ready, e: 'XX' })).toBeNull();
  expect(parseInsuranceSnapshot({ ...ready, s: 'off' })).toBeNull();
  expect(parseInsuranceSnapshot({ ...ready, t: 3001 })).toBeNull();
  expect(parseInsuranceSnapshot({ ...ready, n: -1 })).toBeNull();
  expect(validInsuranceConfig({ ...defaultInsuranceConfig, bins: 13 })).toBe(false);
  expect(validInsuranceConfig({ ...defaultInsuranceConfig, min: 1.5 })).toBe(false);
});
it('treats failed trials as independent tests without directing tag replacement', () => {
  const first = parseInsuranceSnapshot({ ...ready, s: 'no_read', t: 3000 })!;
  expect(insuranceInstruction(first)).toContain('independent test');
  expect(insuranceInstruction({ ...first, attempt: 2 })).not.toContain('Replace');
  expect(insuranceInstruction({ ...first, state: 'error', reason: 3 })).toContain('not a tag quality verdict');
});
it('fits the worst-case status in one 182-byte notification', () => {
  const packet = { ...ready, s: 'cancelled', id: 0xffffffff, n: 0xffffffff, e: 'F'.repeat(32), a: 2, t: 3000, b: 12, g: 3000, r: 6, z: 1 };
  expect(new TextEncoder().encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(182);
});
it('keeps the Normal button disabled while a detected second tag is still being stopped', () => {
  rx({ ...ready, s: 'more', z: 1 });
  const value = controller;
  act(() => root.render(<TagInsuranceTab controller={value} connected busy={false} settings={settings} settingsActivity={null} onSettingsAction={vi.fn()} />));
  expect(container.querySelector('button')?.disabled).toBe(true);
  expect(container.querySelector('fieldset')?.disabled).toBe(true);
  expect(container.textContent).toContain('Finishing');
});

it('configures current RF values on the Insurance page without imposing a preset', () => {
  rx(off);
  const value = controller;
  const action = vi.fn();
  act(() => root.render(<TagInsuranceTab controller={value} connected busy={false} settings={settings} settingsActivity={null} onSettingsAction={action} />));
  expect(container.textContent).not.toContain('Fixed preset');
  expect(container.textContent).not.toContain('Bluetooth Device Name');
  expect(container.querySelector<HTMLSelectElement>('[aria-label="RF link profile"]')?.value).toBe('5185');
  expect(container.querySelector<HTMLSelectElement>('[aria-label="session"]')?.value).toBe('255');
  expect(action).not.toHaveBeenCalled();
  const power = container.querySelector('[aria-label="Power"]')!;
  const apply = Array.from(power.querySelectorAll('button')).find(b => b.textContent === 'Apply')!;
  act(() => apply.click());
  expect(action).toHaveBeenCalledWith({ id: 'power', mode: 'apply', value: 24 });
  action.mockClear();
  act(() => root.render(<TagInsuranceTab controller={{ ...value, locked: true, snapshot: parseInsuranceSnapshot(ready) }} connected busy={false} settings={settings} settingsActivity={null} onSettingsAction={action} />));
  expect(container.querySelector<HTMLFieldSetElement>('[aria-label="Device configuration"]')?.disabled).toBe(true);
  act(() => apply.click()); expect(action).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Stop Tag Insurance above to change settings');
});

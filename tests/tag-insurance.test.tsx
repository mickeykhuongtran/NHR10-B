import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTagInsurance, TagInsuranceController } from '../hooks/useTagInsurance';
import { ConnectionStatus, Settings } from '../types';
import { TagInsuranceTab } from '../components/dashboard/TagInsuranceTab';
import { defaultInsuranceConfig, insuranceInstruction, parseInsuranceConfig, parseInsuranceSnapshot, validInsuranceConfig } from '../utils/tagInsurance';
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

it('keeps activation pending through stale OFF and ignores duplicate commands', async () => {
  rx(off);
  await act(async () => controller.setMode(true, defaultInsuranceConfig));
  const count = ble.sendCommand.mock.calls.length;
  rx(off);
  expect(controller.pending).toBe(true);
  await act(async () => controller.setMode(false, defaultInsuranceConfig));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(ble.sendCommand).toHaveBeenCalledTimes(count);
  rx(ready);
  expect(controller.pending).toBe(false);
});

it('recovers from missing boot status without guessing the current mode', async () => {
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(controller.error).toContain('No Insurance status');
  expect(controller.isLocked()).toBe(true);
  rx({ cmd: 'GTI', status: 'err', msg: 'booting' });
  expect(controller.error).toContain('Device: booting');
  rx(off);
  expect(controller.error).toBe('');
  expect(controller.isLocked()).toBe(false);
});

it.each([new Error('GATT query rejected'), 'failure'])('reports query failure and retains the confirmed mode: %s', async failure => {
  rx(ready);
  ble.sendCommand.mockRejectedValueOnce(failure);
  await act(async () => controller.query());
  expect(controller.error).toBe(failure instanceof Error ? failure.message : 'Status query failed');
  expect(controller.snapshot?.enabled).toBe(true);
});

it.each([new Error('GATT write rejected'), 'failure'])('resynchronizes after a failed mode write: %s', async failure => {
  rx(off);
  ble.sendCommand.mockRejectedValueOnce(failure);
  await act(async () => controller.setMode(true, defaultInsuranceConfig));
  expect(controller.error).toBe(failure instanceof Error ? failure.message : 'Mode command failed');
  expect(controller.pending).toBe(false);
  expect(controller.snapshot).toBeNull();
  expect(controller.isLocked()).toBe(true);
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GTI' });
  rx(ready); // The write may have reached the device before the link failed.
  expect(controller.snapshot?.enabled).toBe(true);
});

it.each(['query', 'mode'])('ignores the previous connection failure after reconnect: %s', async operation => {
  rx(off);
  let reject!: (reason: Error) => void;
  ble.sendCommand.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  let pending!: Promise<void>;
  act(() => { pending = operation === 'query' ? controller.query() : controller.setMode(true, defaultInsuranceConfig); });
  act(() => root.render(<Harness revision={2} />));
  rx(ready);
  await act(async () => { reject(new Error('old connection')); await pending; });
  expect(controller.error).toBe('');
  expect(controller.snapshot?.enabled).toBe(true);
  expect(controller.pending).toBe(false);
});

it('rejects mode requests without status, with invalid thresholds, or while disconnected', async () => {
  await act(async () => controller.setMode(true, defaultInsuranceConfig));
  rx(off);
  await act(async () => controller.setMode(true, { ...defaultInsuranceConfig, bins: 13 }));
  act(() => root.render(<Harness status="disconnected" />));
  await act(async () => controller.setMode(true, defaultInsuranceConfig));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(ble.sendCommand.mock.calls.map(([command]) => command.cmd)).toEqual(['GTI']);
});

it('does not replace valid status or time capability with malformed notifications', () => {
  rx(ready); rx({ cmd: 'TIC', ...defaultInsuranceConfig, dur: 5000 });
  rx({ ...ready, t: 30001, dur: 30000 });
  rx({ cmd: 'TIC', ...defaultInsuranceConfig, dur: '5000' });
  expect(controller.config.dur).toBe(5000);
  expect(controller.snapshot?.elapsed).toBe(0);
  expect(controller.handleDataReceived({ cmd: 'GP', val: 10 })).toBe(false);
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
  const packet = { ...ready, s: 'cancelled', id: 0xffffffff, n: 0xffffffff, e: 'F'.repeat(32), a: 2, t: 30000, b: 120, g: 30000, r: 6, z: 1, dur: 30000 };
  expect(new TextEncoder().encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(182);
  expect(parseInsuranceSnapshot(packet)?.duration).toBe(30000);
});

it('accepts configurable timing and partial final bins, with strict limits', () => {
  const short = { ...defaultInsuranceConfig, dur: 1001, bins: 5, gap: 1001 };
  expect(validInsuranceConfig(short)).toBe(true);
  expect(validInsuranceConfig({ ...short, dur: 1000 })).toBe(false);
  expect(validInsuranceConfig({ ...short, gap: 1002 })).toBe(false);
  expect(validInsuranceConfig({ ...short, dur: 999 })).toBe(false);
  expect(validInsuranceConfig({ ...short, dur: 30001 })).toBe(false);
  expect(validInsuranceConfig({ ...short, dur: 1500.5 })).toBe(false);
  expect(validInsuranceConfig({ ...short, dur: 30000, bins: 120 })).toBe(true);
  expect(parseInsuranceConfig({ cmd: 'TIC', min: 30, bins: 10, gap: 500 })).toEqual(defaultInsuranceConfig);
  expect(parseInsuranceConfig({ cmd: 'TIC', ...short, dur: '1001' })).toBeNull();
  expect(parseInsuranceSnapshot({ ...ready, dur: 5000, t: 5001 })).toBeNull();
  expect(parseInsuranceSnapshot({ ...ready, dur: 1001, b: 6 })).toBeNull();
  expect(parseInsuranceSnapshot({ ...ready, dur: 5000, t: 4000 })?.elapsed).toBe(4000);
});

it('refuses custom time on legacy/unknown firmware and resets capability on reconnect', async () => {
  rx(off);
  await act(async () => controller.setMode(true, { ...defaultInsuranceConfig, dur: 5000 }));
  expect(controller.pending).toBe(false);
  expect(ble.sendCommand).toHaveBeenCalledTimes(1); // GTI only
  rx({ cmd: 'TIC', min: 30, bins: 10, gap: 500 });
  expect(controller.durationSupported).toBe(false);
  rx({ cmd: 'TIC', ...defaultInsuranceConfig, dur: 5000 });
  expect(controller.durationSupported).toBe(true);
  await act(async () => controller.setMode(true, { ...defaultInsuranceConfig, dur: 5000 }));
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'TI', val: 1, ...defaultInsuranceConfig, dur: 5000 });
  rx({ ...ready, dur: 5000 });
  expect(controller.pending).toBe(false);
  act(() => root.render(<Harness status="disconnected" />));
  expect(controller.durationSupported).toBeNull();
  expect(controller.config).toEqual(defaultInsuranceConfig);
});

it('uses snapshot timing for result progress even if TIC was missed', () => {
  rx({ ...ready, s: 'running', id: 2, z: 1, t: 4000, b: 16, dur: 5000 });
  const value = controller;
  act(() => root.render(<TagInsuranceTab controller={value} connected busy={false} settings={settings} settingsActivity={null} onSettingsAction={vi.fn()} />));
  expect(container.querySelector('progress')?.max).toBe(5000);
  expect(container.querySelector('progress')?.value).toBe(4000);
  expect(container.querySelector<HTMLInputElement>('#ti-dur')?.value).toBe('5000');
  expect(container.textContent).toContain('16/20 occupied time bins');
  expect(container.textContent).not.toContain('3-second');
});

it('exposes Remain Time and blocks inconsistent thresholds without silently changing them', () => {
  rx(off);rx({ cmd: 'TIC', ...defaultInsuranceConfig });
  const value=controller;
  act(() => root.render(<TagInsuranceTab controller={value} connected busy={false} settings={settings} settingsActivity={null} onSettingsAction={vi.fn()} />));
  const time=container.querySelector<HTMLInputElement>('#ti-dur')!;
  expect(time.disabled).toBe(false);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(time,'1000');
    time.dispatchEvent(new Event('input',{bubbles:true}));
  });
  expect(container.querySelector<HTMLInputElement>('#ti-bins')?.value).toBe('10');
  expect(container.querySelector<HTMLInputElement>('#ti-bins')?.max).toBe('4');
  expect(container.querySelector('button')?.disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('windows 1–4');
});

it('uses fixed legacy timing after switching devices without trapping a custom draft', () => {
  rx(off);rx({ cmd: 'TIC', ...defaultInsuranceConfig, dur: 5000 });
  const value=controller;
  const setMode=vi.fn().mockResolvedValue(undefined);
  const draw=(supports:boolean) => root.render(<TagInsuranceTab controller={{ ...value, durationSupported:supports, setMode }} connected busy={false} settings={settings} settingsActivity={null} onSettingsAction={vi.fn()} />);
  act(() => draw(true));
  expect(container.querySelector<HTMLInputElement>('#ti-dur')?.value).toBe('5000');
  act(() => draw(false));
  expect(container.querySelector<HTMLInputElement>('#ti-dur')?.value).toBe('3000');
  expect(container.querySelector<HTMLInputElement>('#ti-dur')?.disabled).toBe(true);
  act(() => container.querySelector('button')!.click());
  expect(setMode).toHaveBeenCalledWith(true,defaultInsuranceConfig);
});
it('explains data integrity errors without turning passing metrics into a quality verdict', () => {
  rx({ ...ready, s: 'error', r: 2, id: 1, e: 'E280689400005035E6130838', n: 186, t: 2999, b: 12, g: 49 });
  const value = controller;
  act(() => root.render(<TagInsuranceTab controller={value} connected busy={false} settings={settings} settingsActivity={null} onSettingsAction={vi.fn()} />));
  expect(container.textContent).toContain('Read data integrity error');
  expect(container.textContent).toContain('r=2');
  expect(container.textContent).toContain('not a tag quality verdict');
  expect(container.textContent).toContain('lowering thresholds will not resolve');
  expect(container.textContent).not.toContain('TAG OK');
});
it('explains total reads, time coverage and longest silence separately', () => {
  rx(off);
  const value = controller;
  act(() => root.render(<TagInsuranceTab controller={value} connected busy={false} settings={settings} settingsActivity={null} onSettingsAction={vi.fn()} />));
  expect(container.textContent).toContain('not 30 reads per second');
  expect(container.textContent).toContain('12 windows');
  expect(container.textContent).toContain('start to first read and last read to the end');
  expect(container.querySelector('#ti-gap')?.getAttribute('aria-describedby')).toBe('ti-gap-help');
});
it('keeps the Normal button disabled while a detected second tag is still being stopped', () => {
  rx({ ...ready, s: 'more', z: 1 });
  const value = controller;
  act(() => root.render(<TagInsuranceTab controller={value} connected busy={false} settings={settings} settingsActivity={null} onSettingsAction={vi.fn()} />));
  expect(container.querySelector('button')?.disabled).toBe(true);
  expect(container.querySelector('fieldset')?.disabled).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('CHECK TAG');
  expect(container.querySelector('[role="status"] svg')?.classList.contains('text-amber-500')).toBe(true);
  expect(container.textContent).toContain('not a tag quality verdict');
});

it.each([
  ['more', 'CHECK TAG', 'text-amber-500'],
  ['no_read', 'NO TAG FOUND', 'text-amber-500'],
  ['check', 'TAG ERROR', 'text-red-600'],
  ['error', 'TEST ERROR', 'text-red-600'],
  ['ok', 'TAG OK', 'text-emerald-600'],
])('distinguishes %s results without changing the wire state', (state, title, iconColor) => {
  rx({ ...ready, s: state, z: 0, t: 3000 });
  const value = controller;
  act(() => root.render(<TagInsuranceTab controller={value} connected busy={false} settings={settings} settingsActivity={null} onSettingsAction={vi.fn()} />));
  const result = container.querySelector('[role="status"]');
  expect(result?.textContent).toBe(title);
  expect(result?.querySelector('svg')?.classList.contains(iconColor)).toBe(true);
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

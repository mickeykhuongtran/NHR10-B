import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRFIDConnection } from '../hooks/useRFIDConnection';
import { batteryView } from '../utils/battery';

const ble = vi.hoisted(() => Object.fromEntries([
  'connect', 'disconnect', 'getDeviceIdentity', 'getDeviceName', 'getDeviceInfo',
  'getInfo', 'getBattery', 'getPower', 'getProfile', 'getQSession', 'getQueryParam', 'getTagFocus',
  'getRegion', 'getTemperature', 'getSettings', 'isIntentionalUnpairPending', 'recoverFromUnexpectedLinkTimeout',
].map(name => [name, vi.fn()])));
vi.mock('../services/bleService', () => ({ bleService: ble }));

let root: Root;
let connection: ReturnType<typeof useRFIDConnection>;
const packet = { cmd: 'GB', ver: 2, voltage: 7500, state: 'NORMAL', load: 'idle', percent: 61.3, valid: true, charging: false, full: false, health: 0, age_ms: 0 };
const receive = (overrides = {}) => act(() => connection.handleDataReceived({ ...packet, ...overrides }));
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
  for (const mock of Object.values(ble)) mock.mockReset().mockResolvedValue(undefined);
  ble.getDeviceIdentity.mockReturnValue(null);
  ble.getDeviceName.mockReturnValue('NHR-10');
  ble.isIntentionalUnpairPending.mockReturnValue(false);
  ble.recoverFromUnexpectedLinkTimeout.mockReturnValue(false);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  function Harness() { connection = useRFIDConnection(); return null; }
  root = createRoot(document.createElement('div'));
  act(() => root.render(<Harness />));
  await act(async () => { await connection.connect(); });
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it.each(['idle', 'interactive', 'batch', 'batchSaving', 'locate'] as const)('polls GB at five seconds in %s mode', async mode => {
  expect(ble.getBattery).toHaveBeenCalledOnce();
  receive();
  act(() => connection.setInventoryActive(mode !== 'idle', mode));
  await advance(4999); expect(ble.getBattery).toHaveBeenCalledOnce();
  await advance(1); expect(ble.getBattery).toHaveBeenCalledTimes(2);
  await advance(5000); expect(ble.getBattery).toHaveBeenCalledTimes(3);
});

it('refreshes on foreground, coalesces a blocked poll across mode changes and stops on disconnect', async () => {
  let release!: () => void;
  ble.getBattery.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  await advance(5000);
  act(() => connection.setInventoryActive(true, 'batchSaving'));
  for (let i = 0; i < 3; i++) act(() => document.dispatchEvent(new Event('visibilitychange')));
  await advance(20000);
  expect(ble.getBattery).toHaveBeenCalledTimes(2);
  await act(async () => release());
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(ble.getBattery).toHaveBeenCalledTimes(3);
  await act(async () => {});
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(ble.getBattery).toHaveBeenCalledTimes(3);
  act(() => connection.disconnect());
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await advance(20000); expect(ble.getBattery).toHaveBeenCalledTimes(3);
});

it('expires the battery during live RFID traffic without declaring the device disconnected', async () => {
  receive({ percent: 100, full: true, charging: true });
  act(() => connection.setInventoryActive(true, 'interactive'));
  for (let i = 0; i < 3; i++) {
    await advance(5000);
    act(() => connection.handleDataReceived({ cmd: 'live_tags', d: [['E200', -60, 1, 1]] }));
  }
  expect(connection.status).toBe('connected');
  expect(connection.settings.batterySnapshot?.stale).toBe(true);
  expect(batteryView(connection.settings.batterySnapshot)).toMatchObject({ status: 'STALE', percent: null, charging: null, full: false });
  receive({ percent: 99.9 });
  expect(batteryView(connection.settings.batterySnapshot).text).toBe('99.9%');
});

it('expires during batch saving and replaces an old value with invalid or legacy data', async () => {
  receive();
  receive({ percent: null, valid: false, voltage: 0, age_ms: 0xffffffff });
  expect(batteryView(connection.settings.batterySnapshot).text).toBe('—');
  receive({ percent: 100, full: true });
  act(() => connection.setInventoryActive(true, 'batchSaving'));
  await advance(15000);
  expect(batteryView(connection.settings.batterySnapshot).status).toBe('STALE');
  receive({ ver: undefined });
  expect(batteryView(connection.settings.batterySnapshot).status).toBe('UPDATE FIRMWARE');
});

it('latches unsolicited shutdown through later packets and clears it on disconnect/device selection', async () => {
  receive({ state: 'shutdown', percent: 0, age_ms: 20000 });
  act(() => connection.setInventoryActive(true, 'batchSaving'));
  await advance(20000);
  receive();
  expect(batteryView(connection.settings.batterySnapshot).status).toBe('SHUTDOWN');
  act(() => connection.handleConnectionStatusChange('disconnected'));
  expect(connection.settings.batterySnapshot).toBeNull();
  await act(async () => { await connection.connect(); });
  expect(connection.settings.batterySnapshot).toBeNull();
  receive(); expect(batteryView(connection.settings.batterySnapshot).text).toBe('61.3%');
});

it('does not let an unsolicited GB mark identity verification complete', () => {
  act(() => connection.handleConnectionStatusChange('connecting'));
  receive();
  expect(connection.status).toBe('connecting');
});

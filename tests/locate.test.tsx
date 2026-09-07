import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LOCATE_STALE_MS, useLocateLogic } from '../hooks/useLocateLogic';

const ble = vi.hoisted(() => ({ locateTag: vi.fn(), stopScan: vi.fn() }));
vi.mock('../services/bleService', () => ({ bleService: ble }));
const epc = 'E20000112233445566778899';
let locate: ReturnType<typeof useLocateLogic>;
let root: Root;
const log = vi.fn();
function Harness() { locate = useLocateLogic(log); return null; }
const receive = (rssi: unknown, target = epc) => act(() => locate.handleDataReceived({ cmd: 'F', epc: target, rssi }));
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  ble.locateTag.mockResolvedValue(undefined); ble.stopScan.mockResolvedValue(undefined);
  root = createRoot(document.createElement('div')); act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it('maps the firmware -100 sentinel to lost and recovers on the next target read', async () => {
  await act(async () => locate.startLocate(epc));
  expect(locate.signalState).toBe('waiting');
  receive(-63); expect(locate.targetRssi).toBe(-63); expect(locate.signalState).toBe('detected');
  receive(-100); expect(locate.targetRssi).toBeNull(); expect(locate.signalState).toBe('lost'); expect(locate.isLocating).toBe(true);
  receive(-99); expect(locate.targetRssi).toBe(-99); expect(locate.signalState).toBe('detected');
});
it('expires an old reading if the BLE lost packet never arrives', async () => {
  await act(async () => locate.startLocate(epc)); receive(-60);
  act(() => vi.advanceTimersByTime(LOCATE_STALE_MS - 1)); expect(locate.signalState).toBe('detected');
  receive(-62);
  act(() => vi.advanceTimersByTime(LOCATE_STALE_MS - 1)); expect(locate.targetRssi).toBe(-62);
  act(() => vi.advanceTimersByTime(1)); expect(locate.signalState).toBe('lost'); expect(locate.targetRssi).toBeNull();
});
it('ignores other targets and malformed readings without extending freshness', async () => {
  await act(async () => locate.startLocate(epc)); receive(-60);
  act(() => vi.advanceTimersByTime(2000));
  receive(-100, 'AABBCCDD'); receive(null); receive(''); receive('bad'); receive(Number.NaN);
  expect(locate.targetRssi).toBe(-60);
  act(() => vi.advanceTimersByTime(500)); expect(locate.signalState).toBe('lost');
});
it('keeps an immediate first response and ignores packets after stop or disconnect', async () => {
  ble.locateTag.mockImplementation(async () => locate.handleDataReceived({ cmd: 'F', epc, rssi: -70 }));
  await act(async () => locate.startLocate(epc)); expect(locate.signalState).toBe('detected');
  await act(async () => locate.stopLocate()); receive(-60);
  expect(locate.signalState).toBe('idle'); expect(locate.targetRssi).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  await act(async () => locate.startLocate(epc)); act(() => locate.resetLocateState()); receive(-65);
  expect(locate.isLocating).toBe(false); expect(locate.signalState).toBe('idle'); expect(vi.getTimerCount()).toBe(0);
});
it('does not revive a locate session when a pending start finishes after disconnect', async () => {
  let finish!: () => void;
  ble.locateTag.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = locate.startLocate(epc); });
  act(() => locate.resetLocateState());
  await act(async () => { finish(); await pending; });
  expect(locate.isLocating).toBe(false); expect(locate.signalState).toBe('idle');
});

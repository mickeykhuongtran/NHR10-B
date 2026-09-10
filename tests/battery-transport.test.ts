import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bleService } from '../services/bleService';

const GB = { cmd: 'GB', voltage: 7500, state: 'NORMAL', load: 'load', ver: 2, percent: 61.3, valid: true, charging: false, full: false, health: 0, age_ms: 200 };
const DI = { cmd: 'DI', val: 'NHR-10', id: 'NHR10-112233445566', display_id: '445566' };
let cmd: FakeCharacteristic;
let fileReq: FakeCharacteristic;
let fileData: FakeCharacteristic;
let onData = vi.fn<(data: any) => void>();
let writes: string[];

class FakeCharacteristic extends EventTarget {
  value?: DataView;
  properties = { write: true, notify: true };
  startNotifications = vi.fn(async () => this);
  writeValueWithResponse = vi.fn(async (bytes: BufferSource) => {
    const text = new TextDecoder().decode(bytes);
    writes.push(text);
    if (text === '{"cmd":"DI"}') this.notify(DI);
  });
  writeValue = vi.fn(async (bytes: BufferSource) => { writes.push(new TextDecoder().decode(bytes)); });
  notify(data: object) {
    // GB is one JSON notification, with no terminator or application framing.
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    this.value = new DataView(encoded.buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
  writes = [];
  cmd = new FakeCharacteristic(); fileReq = new FakeCharacteristic(); fileData = new FakeCharacteristic();
  const device = Object.assign(new EventTarget(), { id: 'fixture', name: 'NHR-10', gatt: null as any });
  device.gatt = {
    connected: true, connect: vi.fn(async () => device.gatt), disconnect: vi.fn(() => { device.gatt.connected = false; }),
    getPrimaryService: vi.fn(async () => ({ getCharacteristic: vi.fn(async (uuid: string) => uuid.includes('ff01') ? cmd : uuid.includes('ff02') ? fileReq : fileData) })),
  };
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: vi.fn(async () => device) }, configurable: true });
  onData = vi.fn();
  bleService.setCallbacks(onData, vi.fn(), vi.fn(), vi.fn());
  await bleService.connect();
  writes = []; onData.mockClear();
});
afterEach(() => { bleService.disconnect(); vi.useRealTimers(); });

it('subscribes before GB and routes battery, settings and live tags on the same FF01 channel', async () => {
  const request = bleService.getBattery();
  await vi.advanceTimersByTimeAsync(100);
  await request;
  expect(cmd.startNotifications.mock.invocationCallOrder[0]).toBeLessThan(cmd.writeValueWithResponse.mock.invocationCallOrder[0]);
  expect(writes).toEqual(['{"cmd":"GB"}']);
  bleService.resumeLiveTags();
  cmd.notify({ cmd: 'live_tags', seq: 1, d: [['E200', -65, 1, 1]] });
  cmd.notify(GB);
  cmd.notify({ cmd: 'GP', val: 20 });
  cmd.notify({ ...GB, state: 'shutdown', percent: 0 });
  await vi.advanceTimersByTimeAsync(100);
  expect(onData.mock.calls.map(([data]) => data.cmd).sort()).toEqual(['GB', 'GB', 'GP', 'live_tags']);
  expect(onData).toHaveBeenCalledWith(GB);
});

it('coalesces all battery refreshes behind a busy write and cancels queued GB on disconnect', async () => {
  let release!: () => void;
  cmd.writeValueWithResponse.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const setting = bleService.getPower();
  await vi.advanceTimersByTimeAsync(100);
  const first = bleService.getBattery();
  for (let i = 0; i < 20; i++) expect(bleService.getBattery()).toBe(first);
  await vi.advanceTimersByTimeAsync(20000);
  expect(writes).toEqual([]);
  release(); await setting;
  await vi.advanceTimersByTimeAsync(100); await first;
  expect(writes).toEqual(['{"cmd":"GB"}']);
  const canceled = bleService.getBattery();
  bleService.disconnect();
  await vi.advanceTimersByTimeAsync(100); await canceled;
  expect(writes).toEqual(['{"cmd":"GB"}']);
});

it('recovers polling after a failed GATT write', async () => {
  cmd.writeValueWithResponse.mockRejectedValueOnce(new Error('GATT busy'));
  const first = bleService.getBattery();
  const rejection = expect(first).rejects.toThrow('GATT busy');
  await vi.advanceTimersByTimeAsync(100); await rejection;
  const next = bleService.getBattery();
  await vi.advanceTimersByTimeAsync(100); await next;
  expect(writes).toEqual(['{"cmd":"GB"}']);
});

it('serializes file subscription/control with GB writes', async () => {
  let release!: () => void;
  fileData.startNotifications.mockImplementationOnce(() => new Promise<FakeCharacteristic>(resolve => { release = () => resolve(fileData); }));
  const transfer = bleService.requestFileTransfer();
  await vi.advanceTimersByTimeAsync(100);
  const battery = bleService.getBattery();
  await vi.advanceTimersByTimeAsync(10000);
  expect(writes).toEqual([]);
  release(); await transfer;
  expect(writes).toEqual(['send_file']);
  await vi.advanceTimersByTimeAsync(100); await battery;
  expect(writes).toEqual(['send_file', '{"cmd":"GB"}']);
});

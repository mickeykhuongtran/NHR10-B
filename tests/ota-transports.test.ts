import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OtaBleTransport } from '../services/otaBleTransport';
import { OTA_UUID, makeFrame } from '../services/otaProtocol';
import { statusBytes, testInfo } from './ota-fixtures';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function bleFixture(timeout = 10000) {
  const ack = Object.assign(new EventTarget(), { value: new DataView(new ArrayBuffer(0)), startNotifications: vi.fn(async () => ack), stopNotifications: vi.fn(async () => ack) });
  const snapshot = { state: 2, source: 1, error: 0, seq: 77, offset: 170, total: 901 };
  const statusReader = { readValue: vi.fn(async () => new DataView(statusBytes(snapshot).buffer)) };
  const infoReader = { readValue: vi.fn(async () => new DataView(new TextEncoder().encode(JSON.stringify(testInfo)).buffer)) };
  const writer = { writeValueWithResponse: vi.fn(async () => undefined) };
  const device = Object.assign(new EventTarget(), { id: 'browser-device', gatt: { connected: true, disconnect: vi.fn(() => { device.gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); }) } });
  const server = { getPrimaryService: vi.fn(async () => ({ getCharacteristic: vi.fn(async uuid => ({ [OTA_UUID.write]: writer, [OTA_UUID.status]: statusReader, [OTA_UUID.info]: infoReader, [OTA_UUID.ack]: ack })[uuid]) })) };
  const session = { device, canonicalId: testInfo.id, getServer: vi.fn(async () => server), release: vi.fn() };
  const transport = new OtaBleTransport(session as any, vi.fn(), timeout);
  const notify = () => { ack.value = new DataView(statusBytes(snapshot).buffer); ack.dispatchEvent(new Event('characteristicvaluechanged')); };
  return { transport, ack, writer, device, snapshot, statusReader, session, notify };
}
it('subscribes to ACK before transfer, caches an early ACK and preserves the borrowed BLE link on close', async () => {
  const f = bleFixture(); await f.transport.open(); expect(f.ack.startNotifications).toHaveBeenCalledOnce();
  f.notify(); await f.transport.write(makeFrame(3, 77, 0, new Uint8Array(170)));
  expect((await f.transport.waitStatus(s => s.seq === 77, 10000, () => false)).offset).toBe(170);
  expect(f.statusReader.readValue).not.toHaveBeenCalled();
  await f.transport.close(); expect(f.ack.stopNotifications).toHaveBeenCalledOnce(); expect(f.device.gatt.disconnect).not.toHaveBeenCalled();
});
it('recovers a lost BLE notification by reading durable status without retransmitting DATA', async () => {
  const f = bleFixture(); await f.transport.open(); await f.transport.write(makeFrame(3, 77, 0, new Uint8Array(170)));
  const waiting = f.transport.waitStatus(s => s.seq === 77, 10000, () => false);
  await vi.advanceTimersByTimeAsync(500); expect((await waiting).offset).toBe(170);
  expect(f.writer.writeValueWithResponse).toHaveBeenCalledOnce(); expect(f.statusReader.readValue).toHaveBeenCalledOnce(); await f.transport.close();
});
it('retires hung BLE writes and ignores late completions', async () => {
  const f = bleFixture(30); await f.transport.open(); let finish!: () => void;
  f.writer.writeValueWithResponse.mockImplementation(() => new Promise(resolve => { finish = () => resolve(undefined); }));
  const write = f.transport.write(makeFrame(3, 1)).catch(error => error);
  await vi.advanceTimersByTimeAsync(31); expect((await write).message).toMatch(/timed out/); expect(f.device.gatt.disconnect).toHaveBeenCalledOnce();
  finish(); await expect(f.transport.write(makeFrame(3, 2))).rejects.toThrow(/retired/); await f.transport.close();
});
it('interrupts pending BLE I/O on an ordinary disconnect', async () => {
  const f = bleFixture(); await f.transport.open();
  f.statusReader.readValue.mockImplementation(() => new Promise(() => {}));
  const read = f.transport.status().catch(error => error); await Promise.resolve(); f.device.gatt.disconnect();
  expect((await read).message).toMatch(/disconnected/); await f.transport.close();
});

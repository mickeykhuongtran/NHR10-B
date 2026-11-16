import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bleService, OtaBleSession } from '../services/bleService';
import { OTA_UUID } from '../services/otaProtocol';

let device: any, cmd: Characteristic, fileData: Characteristic;
let session: OtaBleSession | undefined;
let connection = vi.fn<(status: string, reason?: string) => void>();
let received = vi.fn<(data: any) => void>();
let writes: string[];
class Characteristic extends EventTarget {
  value?: DataView;
  properties = { write: true, notify: true };
  startNotifications = vi.fn(async () => this);
  writeValueWithResponse = vi.fn(async (bytes: BufferSource) => {
    const text = new TextDecoder().decode(bytes); writes.push(text);
    if (text === '{"cmd":"DI"}') this.notify({ cmd: 'DI', val: 'NHR-10' });
  });
  writeValue = this.writeValueWithResponse;
  notify(data: object) {
    this.value = new DataView(new TextEncoder().encode(JSON.stringify(data)).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}
beforeEach(async () => {
  vi.useFakeTimers(); writes = []; session = undefined;
  cmd = new Characteristic(); fileData = new Characteristic();
  const fileReq = new Characteristic();
  device = Object.assign(new EventTarget(), { id: 'same-browser-reader', name: 'NHR-10', gatt: null });
  device.gatt = {
    connected: true,
    connect: vi.fn(async () => { device.gatt.connected = true; return device.gatt; }),
    disconnect: vi.fn(() => { device.gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); }),
    getPrimaryService: vi.fn(async () => ({ getCharacteristic: async (id: string) => id.includes('ff01') ? cmd : id.includes('ff02') ? fileReq : fileData })),
  };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: vi.fn(async () => device) } });
  connection = vi.fn(); received = vi.fn();
  bleService.setCallbacks(received, vi.fn(), vi.fn(), connection);
  await bleService.connect(); writes = []; received.mockClear();
});
afterEach(async () => { await session?.release(false); bleService.disconnect(); vi.useRealTimers(); });

it('grants OTA permission, lends the original REVB connection, and excludes commands/files until release', async () => {
  expect((navigator as any).bluetooth.requestDevice.mock.calls[0][0].optionalServices).toContain(OTA_UUID.service);
  session = await bleService.acquireOtaSession();
  expect(session.device).toBe(device); expect(session.canonicalId).toBeNull();
  expect(await session.getServer()).toBe(device.gatt);
  await expect(bleService.acquireOtaSession()).rejects.toThrow(/already active/);
  await expect(bleService.getBattery()).rejects.toThrow(/paused/);
  await expect(bleService.setPower(20)).rejects.toThrow(/paused/);
  await expect(bleService.requestFileTransfer()).rejects.toThrow(/paused/);
  await expect(bleService.connect()).rejects.toThrow(/update/);
  cmd.notify({ cmd: 'GB', percent: 10 }); expect(received).not.toHaveBeenCalled();
  expect(await session.release(true)).toBe(true); expect(await session.release(true)).toBe(false);
  expect(bleService.isUpdating()).toBe(false);
  await expect(session.getServer()).rejects.toThrow(/available/);
});
it('drains the outstanding ATT write and cancels queued battery work before OTA admission', async () => {
  let finish!: () => void;
  cmd.writeValueWithResponse.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const writing = bleService.getPower();
  await vi.advanceTimersByTimeAsync(100);
  const queued = bleService.getBattery().catch(error => error);
  const acquired = vi.fn();
  const acquiring = bleService.acquireOtaSession().then(value => { session = value; acquired(); });
  await vi.advanceTimersByTimeAsync(500); expect(acquired).not.toHaveBeenCalled();
  finish(); await writing; await acquiring;
  expect(acquired).toHaveBeenCalledOnce(); expect((await queued).message).toMatch(/cancelled/);
  expect(writes).toEqual([]);
});
it('retires a stuck command without opening another connection or leaking OTA ownership', async () => {
  cmd.writeValueWithResponse.mockImplementationOnce(() => new Promise<void>(() => {}));
  void bleService.getPower(); await vi.advanceTimersByTimeAsync(100);
  const acquiring = bleService.acquireOtaSession().catch(error => error);
  await vi.advanceTimersByTimeAsync(10001);
  expect((await acquiring).message).toMatch(/did not finish/);
  expect(bleService.isUpdating()).toBe(false); expect(device.gatt.connected).toBe(false);
  await vi.advanceTimersByTimeAsync(20000); expect(device.gatt.connect).toHaveBeenCalledOnce();
});
it('keeps normal reconnect paused during OTA reboot and restores normal characteristics on the same reader', async () => {
  session = await bleService.acquireOtaSession(); device.gatt.disconnect();
  await vi.advanceTimersByTimeAsync(20000);
  expect(connection).not.toHaveBeenCalled(); expect(device.gatt.connect).toHaveBeenCalledOnce();
  expect(bleService.recoverFromUnexpectedLinkTimeout()).toBe(false);
  expect(await session.getServer()).toBe(device.gatt);
  expect(device.gatt.connect).toHaveBeenCalledTimes(2);
  expect(await session.release(true)).toBe(true);
  expect(bleService.isUpdating()).toBe(false); expect(writes).toEqual(['{"cmd":"DI"}']);
});
it('rejects OTA while the file request/subscription owns GATT', async () => {
  const transfer = bleService.requestFileTransfer();
  await expect(bleService.acquireOtaSession()).rejects.toThrow(/file transfer/);
  await vi.advanceTimersByTimeAsync(100); await transfer;
  expect(bleService.isUpdating()).toBe(false);
});
it('retires an unexpected unpair request during OTA without sending another GATT command', async () => {
  session = await bleService.acquireOtaSession();
  cmd.notify({ cmd: 'UQ', v: 1 });
  expect(device.gatt.connected).toBe(false); expect(writes).toEqual([]);
  await vi.advanceTimersByTimeAsync(20000); expect(device.gatt.connect).toHaveBeenCalledOnce();
});

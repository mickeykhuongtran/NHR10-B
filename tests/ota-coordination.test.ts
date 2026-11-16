import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FirmwareUpdateService } from '../services/firmwareUpdateService';
import { OtaPackage } from '../services/otaPackage';
import { OTA_UUID } from '../services/otaProtocol';
import { testInfo, statusBytes } from './ota-fixtures';
const ble = vi.hoisted(() => ({ acquireOtaSession: vi.fn(), getDeviceIdentity: vi.fn(), getTemperature: vi.fn(), isUpdating: vi.fn(), disconnect: vi.fn() }));
vi.mock('../services/bleService', () => ({ bleService: ble }));
const pkg: OtaPackage = { bytes: new Uint8Array(), manifest: new Uint8Array(108), image: new Uint8Array(901), size: 901, version: '1.2.0-dev.2', project: testInfo.project, imageHash: 'a'.repeat(64), packageHash: 'b'.repeat(64), source: 'engineering', name: 'test.nhrota' };
let service: FirmwareUpdateService;
let session: any;
let writes: ReturnType<typeof vi.fn>;
let coordination: { assertIdle: ReturnType<typeof vi.fn<() => void>>; pause: ReturnType<typeof vi.fn<() => void>>; resume: ReturnType<typeof vi.fn<(connected: boolean) => void>> };
let info: typeof testInfo;
beforeEach(() => {
  vi.clearAllMocks(); info = { ...testInfo };
  ble.getDeviceIdentity.mockReturnValue({ canonicalId: testInfo.id }); ble.getTemperature.mockResolvedValue(undefined);
  const ack = Object.assign(new EventTarget(), { startNotifications: vi.fn(async () => ack), stopNotifications: vi.fn(async () => ack) });
  writes = vi.fn(async () => undefined);
  const characteristics = {
    [OTA_UUID.write]: { writeValueWithResponse: writes },
    [OTA_UUID.status]: { readValue: async () => new DataView(statusBytes({ state: 0, source: 0, error: 0, seq: 0, offset: 0, total: 0 }).buffer) },
    [OTA_UUID.info]: { readValue: async () => new DataView(new TextEncoder().encode(JSON.stringify(info)).buffer) },
    [OTA_UUID.ack]: ack,
  };
  session = { device: Object.assign(new EventTarget(), { gatt: { connected: true, disconnect: vi.fn() } }), canonicalId: testInfo.id,
    getServer: async () => ({ getPrimaryService: async () => ({ getCharacteristic: async (uuid: string) => characteristics[uuid] }) }),
    release: vi.fn(async (resume: boolean) => resume),
  };
  ble.acquireOtaSession.mockResolvedValue(session);
  coordination = { assertIdle: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  service = new FirmwareUpdateService();
});
afterEach(async () => { await service.cancel(); vi.unstubAllGlobals(); });
it('holds one mutex through review, sends no MANIFEST before consent and releases once on cancellation', async () => {
  await service.prepare(pkg, 'ble', false, coordination);
  expect(service.state).toMatchObject({ stage: 'review', active: true, cancellable: true, info });
  expect(writes).not.toHaveBeenCalled(); expect(coordination.pause).toHaveBeenCalledOnce();
  const other = new FirmwareUpdateService(); await other.prepare(pkg, 'ble', false, coordination);
  expect(ble.acquireOtaSession).toHaveBeenCalledOnce();
  await service.cancel(); await service.cancel();
  expect(session.release).toHaveBeenCalledExactlyOnceWith(true); expect(coordination.resume).toHaveBeenCalledExactlyOnceWith(true, info);
  expect(service.state.stage).toBe('cancelled');
  await service.prepare(pkg, 'ble', false, coordination); expect(service.state.stage).toBe('review');
});
it('checks fresh Info and device identity before consent, releases failure and exports only OTA diagnostics', async () => {
  info.hw = 'REV-C'; await service.prepare(pkg, 'ble', false, coordination);
  expect(service.state).toMatchObject({ stage: 'failed', active: false }); expect(writes).not.toHaveBeenCalled();
  expect(session.release).toHaveBeenCalledExactlyOnceWith(false); expect(coordination.resume).toHaveBeenCalledOnce();
  const diagnostics = JSON.stringify(service.diagnostics()); expect(diagnostics).toContain(pkg.packageHash); expect(diagnostics).not.toContain('live_tags');
});
it('refuses preparation during an RFID operation without taking a lease', async () => {
  coordination.assertIdle.mockImplementation(() => { throw new Error('Stop scanning first'); });
  await service.prepare(pkg, 'ble', false, coordination); expect(service.state.message).toContain('Stop scanning');
  expect(ble.acquireOtaSession).not.toHaveBeenCalled(); expect(coordination.pause).not.toHaveBeenCalled();
});
it('accepts the REVB legacy DI response and pins identity from OTA Info on the same GATT device', async () => {
  session.canonicalId = null;
  await service.prepare(pkg, 'ble', false, coordination);
  expect(service.state).toMatchObject({ stage: 'review', info: { id: testInfo.id, hw: 'REV-B' } });
  expect(writes).not.toHaveBeenCalled();
});
it('rejects a different canonical identity when DI provided one', async () => {
  session.canonicalId = 'NHR10-000000000001';
  await service.prepare(pkg, 'ble', false, coordination);
  expect(service.state.stage).toBe('failed'); expect(service.state.message).toMatch(/same device/);
  expect(session.release).toHaveBeenCalledExactlyOnceWith(false);
});
it.each([{ ready: false, pending: false }, { ready: false, pending: true }])('retains device diagnostics when preflight rejects %j without writing firmware', async change => {
  info = { ...info, ...change, fw: '1.2.0' };
  await service.prepare(pkg, 'ble', false, coordination);
  expect(service.state.stage).toBe('failed');
  expect(service.state.message).toMatch(change.pending ? /startup confirmation/ : /read RF power/);
  const diagnostics = service.diagnostics();
  expect(diagnostics.state.info).toMatchObject({ fw: '1.2.0', ...change });
  expect(diagnostics.events.find(e => e.event === 'installed-info')?.detail).toMatchObject({ fw: '1.2.0', ...change });
  expect(writes).not.toHaveBeenCalled();
  expect(session.release).toHaveBeenCalledExactlyOnceWith(false);
});
it('cancels while draining the BLE queue without opening a transport or leaking the lease', async () => {
  let finish!: (session: any) => void;
  ble.acquireOtaSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const preparing = service.prepare(pkg, 'ble', false, coordination);
  await service.cancel(); finish(session); await preparing;
  expect(service.state).toMatchObject({ stage: 'cancelled', active: false });
  expect(writes).not.toHaveBeenCalled(); expect(session.release).toHaveBeenCalledExactlyOnceWith(false);
  expect(coordination.resume).toHaveBeenCalledExactlyOnceWith(false, undefined);
});

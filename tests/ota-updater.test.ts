import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { FirmwareUpdater } from '../services/firmwareUpdateService';
import { parsePackage } from '../services/otaPackage';
import { FakeTransport, packageBytes, testInfo } from './ota-fixtures';
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));
afterEach(() => vi.useRealTimers());
it.each([20, 182, 244, 512])('transfers exact application bytes with acknowledged window 1, frame %i', async frame => {
  const transport = new FakeTransport(); transport.currentInfo.max_frame = frame;
  const pkg = await parsePackage(await packageBytes()), progress = vi.fn();
  const result = await new FirmwareUpdater(transport, progress).run(pkg, testInfo);
  expect(result.fw).toBe(pkg.version); expect(transport.image).toEqual([...pkg.image]);
  expect(transport.writes.every(w => w.length <= frame)).toBe(true);
  expect(new Set(transport.writes.map(w => new DataView(w.buffer).getUint32(4, true))).size).toBe(transport.writes.length);
  expect(progress.mock.calls.some(([s]) => s.stage === 'verifying' && s.cancellable === false)).toBe(true);
});
it.each(['offset', 'source', 'seq', 'state', 'total'] as const)('rejects wrong DATA %s before FINISH', async key => {
  const transport = new FakeTransport(); transport.waitStatus = async () => ({ ...transport.snapshot, [key]: 999 });
  await expect(new FirmwareUpdater(transport).run(await parsePackage(await packageBytes()), testInfo)).rejects.toThrow();
  expect(transport.writes.filter(w => w[3] === 3)).toHaveLength(1); expect(transport.writes.some(w => w[3] === 4)).toBe(false);
});
it('does not retransmit uncertain DATA and confirms ABORT when the connection is healthy', async () => {
  const transport = new FakeTransport(); transport.waitStatus = async () => { throw new Error('Missing durable ACK'); };
  await expect(new FirmwareUpdater(transport).run(await parsePackage(await packageBytes()), testInfo)).rejects.toThrow(/ACK/);
  expect(transport.writes.map(w => w[3])).toEqual([1, 2, 3, 5]);
});
it('never aborts another owner or starts an overlapping transfer', async () => {
  const transport = new FakeTransport(); transport.snapshot = { ...transport.snapshot, state: 2, source: 2 };
  await expect(new FirmwareUpdater(transport).run(await parsePackage(await packageBytes()), testInfo)).rejects.toThrow(/busy/);
  expect(transport.writes).toEqual([]);
});
it('cancels before FINISH with ABORT but ignores cancellation after FINISH could commit', async () => {
  const pkg = await parsePackage(await packageBytes());
  const transport = new FakeTransport();
  const runner = new FirmwareUpdater(transport, s => { if (s.stage === 'transferring') runner.cancel(); });
  await expect(runner.run(pkg, testInfo)).rejects.toThrow(/Cancelled/);
  expect(transport.writes.at(-1)?.[3]).toBe(5); expect(transport.writes.some(w => w[3] === 4)).toBe(false);
  const second = new FakeTransport();
  const committed = new FirmwareUpdater(second, s => { if (s.stage === 'verifying') committed.cancel(); });
  await expect(committed.run(pkg, testInfo)).resolves.toMatchObject({ fw: pkg.version });
  expect(second.writes.some(w => w[3] === 5)).toBe(false);
});
it('recovers lost FINISH completion only by checking post-reboot Info, without ABORT', async () => {
  const transport = new FakeTransport(), write = transport.write.bind(transport);
  transport.write = async frame => { await write(frame); if (frame[3] === 4) throw new Error('Disconnected after commit'); };
  const pkg = await parsePackage(await packageBytes());
  await expect(new FirmwareUpdater(transport).run(pkg, testInfo)).resolves.toMatchObject({ fw: pkg.version });
  expect(transport.writes.some(w => w[3] === 5)).toBe(false);
});
it.each([{ fw: testInfo.fw }, { id: 'NHR10-000000000001' }])('does not report success for rollback or a different reader %j', async change => {
  const transport = new FakeTransport(); Object.assign(transport.bootInfo, change);
  await expect(new FirmwareUpdater(transport).run(await parsePackage(await packageBytes()), testInfo)).rejects.toThrow(/not confirmed|different device/);
  expect(transport.writes.some(w => w[3] === 5)).toBe(false);
});
it('waits for pending startup validation after 100% transfer', async () => {
  vi.useFakeTimers(); const transport = new FakeTransport(); transport.bootInfo.pending = true; transport.bootInfo.ready = false;
  const pkg = await parsePackage(await packageBytes()), completed = vi.fn();
  const work = new FirmwareUpdater(transport).run(pkg, testInfo).then(completed);
  await vi.advanceTimersByTimeAsync(1500); expect(completed).not.toHaveBeenCalled();
  transport.currentInfo = { ...transport.currentInfo, ready: true, pending: false };
  await vi.advanceTimersByTimeAsync(500); await work; expect(completed).toHaveBeenCalledOnce();
});
it('allows slow BEGIN preparation without retrying DATA or flooding BEGIN', async () => {
  vi.useFakeTimers(); const transport = new FakeTransport(); let admitted = false;
  const original = transport.status.bind(transport);
  transport.status = async () => transport.snapshot.state === 2 && transport.image.length === 0 && !admitted ? { ...transport.snapshot, seq: 0 } : original();
  const pkg = await parsePackage(await packageBytes());
  const work = new FirmwareUpdater(transport).run(pkg, testInfo);
  await vi.advanceTimersByTimeAsync(120000); expect(transport.writes.map(w => w[3])).toEqual([1, 2]);
  admitted = true; await vi.advanceTimersByTimeAsync(10); await work;
});

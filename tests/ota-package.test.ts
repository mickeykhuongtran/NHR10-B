import { beforeAll, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertCompatible, parsePackage } from '../services/otaPackage';
import { makeFrame, OtaDeviceError, OTA_RESULTS, parseInfo, parseStatus } from '../services/otaProtocol';
import { packageBytes, statusBytes, testInfo } from './ota-fixtures';
beforeAll(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));

(process.env.NHR_OTA_PACKAGE ? it : it.skip)('accepts the actual REVB build package and exact application payload', async () => {
  const bytes = await readFile(process.env.NHR_OTA_PACKAGE!);
  const pkg = await parsePackage(bytes);
  expect(bytes[6]).toBe(2);
  // Compare all bytes natively; a generic deep matcher walks 1.25 million entries.
  expect(Buffer.from(pkg.image).equals(bytes.subarray(108))).toBe(true);
  expect(pkg.project).toBe('gatt_server_demos');
  expect(pkg.size).toBeLessThanOrEqual(3 * 1024 * 1024);
  expect(() => assertCompatible(pkg, { ...testInfo, fw: '0.0.0' }, 'ble')).not.toThrow();
});

it('validates the complete package, descriptor, exact lengths and both hashes without changing input', async () => {
  const bytes = await packageBytes(), original = bytes.slice();
  const pkg = await parsePackage(bytes);
  expect(pkg.version).toBe('1.2.0-dev.2'); expect(pkg.manifest).toHaveLength(108); expect(pkg.image).toHaveLength(901);
  expect(pkg.packageHash).toMatch(/^[a-f0-9]{64}$/); expect(bytes).toEqual(original);
});
it('rejects truncated, appended, raw, wrong-target and oversized packages', async () => {
  const bytes = await packageBytes();
  for (const altered of [bytes.slice(0, 395), bytes.slice(0, -1), new Uint8Array([...bytes, 0])]) await expect(parsePackage(altered)).rejects.toThrow();
  for (const index of [0, 4, 5, 6, 7, 8]) { const altered = bytes.slice(); altered[index] ^= 1; await expect(parsePackage(altered)).rejects.toThrow(); }
});
it('checks every SHA-256 byte', async () => {
  const bytes = await packageBytes();
  for (let i = 12; i < 44; i++) { const altered = bytes.slice(); altered[i] ^= 1; await expect(parsePackage(altered)).rejects.toThrow(/SHA-256/); }
});
it('rejects missing NUL, nonzero padding and unsafe/non-ASCII package text', async () => {
  for (const offset of [44, 76]) {
    for (const value of [32, 34, 92, 128]) { const bytes = await packageBytes(); bytes[offset] = value; await expect(parsePackage(bytes)).rejects.toThrow(/text/); }
    const missingNull = await packageBytes(); missingNull.fill(65, offset, offset + 32); await expect(parsePackage(missingNull)).rejects.toThrow(/text/);
    const padding = await packageBytes(); padding[offset + 31] = 1; await expect(parsePackage(padding)).rejects.toThrow(/padding/);
  }
});
it('rejects bad chip ID, descriptor magic and mismatched descriptor text even with a valid image hash', async () => {
  for (const offset of [0, 12, 32, 48, 80]) {
    const bytes = await packageBytes(); bytes[108 + offset] ^= 1;
    bytes.set(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes.slice(108))), 12);
    await expect(parsePackage(bytes)).rejects.toThrow(/descriptor/);
  }
});
it('uses semantic prerelease ordering, rejects same versions and requires explicit engineering downgrade', async () => {
  const pkg = await parsePackage(await packageBytes('1.1.0-dev.10'));
  expect(() => assertCompatible(pkg, { ...testInfo, fw: '1.1.0-dev.9' }, 'ble')).not.toThrow();
  expect(() => assertCompatible(pkg, { ...testInfo, fw: pkg.version }, 'ble', true)).toThrow(/already installed/);
  expect(() => assertCompatible(pkg, { ...testInfo, fw: '1.1.0' }, 'ble')).toThrow(/Downgrade/);
  expect(() => assertCompatible(pkg, { ...testInfo, fw: '1.1.0' }, 'ble', true)).not.toThrow();
  expect(() => assertCompatible({ ...pkg, source: 'release' }, testInfo, 'ble', true)).toThrow(/Downgrade/);
});
it.each([{ product: 'other' }, { hw: 'REV-C' }, { protocol: 2 }, { project: 'other' }, { slot_size: 10 }, { charge_only: true }, { ready: false }, { pending: true }, { ota: 'usb' }, { fw: 'bad' }])('rejects incompatible device information %j', async change => {
  const pkg = await parsePackage(await packageBytes()); expect(() => assertCompatible(pkg, { ...testInfo, ...change }, 'ble')).toThrow();
});
it('encodes exact little-endian NU frames and rejects invalid fields', () => {
  expect([...makeFrame(3, 0x12345678, 0x10203040, new Uint8Array([0xaa]))]).toEqual([78,85,1,3,0x78,0x56,0x34,0x12,0x40,0x30,0x20,0x10,0xaa]);
  for (const seq of [0, -1, 1.5, 0x100000000]) expect(() => makeFrame(1, seq)).toThrow();
  expect(() => makeFrame(6, 1)).toThrow(); expect(() => makeFrame(1, 1, -1)).toThrow();
});
it('decodes exact NS status from sliced DataViews and rejects malformed records', () => {
  const expected = { state: 2, source: 1, error: 8, seq: 0x12345678, offset: 900, total: 901 };
  const bytes = statusBytes(expected), padded = new Uint8Array(25); padded.set(bytes, 3);
  expect(parseStatus(new DataView(padded.buffer, 3, 20))).toEqual(expected);
  for (const index of [0, 2, 3, 6, 7]) { const bad = bytes.slice(); bad[index] = 9; expect(() => parseStatus(bad)).toThrow(); }
  expect(() => parseStatus(bytes.slice(1))).toThrow();
  OTA_RESULTS.forEach((message, i) => expect(new OtaDeviceError(i).message).toBe(message));
});
it('rejects malformed Info instead of treating missing flags as readiness', () => {
  const encoded = (data: object) => new TextEncoder().encode(JSON.stringify(data));
  expect(parseInfo(encoded(testInfo))).toEqual(testInfo);
  for (const change of [{ ready: undefined }, { pending: 0 }, { id: 'scanner' }, { max_frame: 513 }, { slot_size: -1 }]) expect(() => parseInfo(encoded({ ...testInfo, ...change }))).toThrow();
});

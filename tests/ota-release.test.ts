import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { packageBytes } from './ota-fixtures';
import { sha256 } from '../services/otaPackage';
beforeEach(() => {
  vi.resetModules(); vi.stubEnv('VITE_FIRMWARE_RELEASE_URL', 'https://firmware.example.test/release.json');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function setup(change = {}) {
  const bytes = await packageBytes();
  const record = { schema: 1, product: 'NHR10-B', hardware: 'REV-B', channel: 'stable', version: '1.2.0-dev.2', url: 'https://firmware.example.test/firmware.nhrota', package_sha256: await sha256(bytes), size: bytes.length, release_notes: 'Test release', ...change };
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(record))).mockResolvedValueOnce(new Response(bytes));
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, record, fetchApprovedRelease: (await import('../services/otaRelease')).fetchApprovedRelease };
}
it('binds an approved HTTPS release to its outer hash and embedded version, omitting credentials and redirects', async () => {
  const { fetcher, fetchApprovedRelease } = await setup();
  await expect(fetchApprovedRelease()).resolves.toMatchObject({ source: 'release', version: '1.2.0-dev.2', releaseNotes: 'Test release' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
});
it.each([{ package_sha256: '0'.repeat(64) }, { version: '1.2.0-dev.3' }, { hardware: 'REV-C' }, { url: 'http://example.test/firmware.nhrota' }, { url: 'https://user:password@example.test/fw' }])('rejects untrusted or mismatched release metadata %j', async change => {
  const { fetchApprovedRelease } = await setup(change); await expect(fetchApprovedRelease()).rejects.toThrow();
});

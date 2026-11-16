import { MAX_OTA_IMAGE_SIZE, parsePackage, sha256 } from './otaPackage';
import { valid } from 'semver';

export const firmwareReleaseUrl: string = import.meta.env.VITE_FIRMWARE_RELEASE_URL ?? '';
function httpsUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Firmware releases must use HTTPS without embedded credentials.');
  return url.href;
}
async function download(url: string, maxSize: number, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(httpsUrl(url), { credentials: 'omit', redirect: 'error', cache: 'no-store', signal });
  if (!response.ok) throw new Error(`Firmware download failed: HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length')) > maxSize) throw new Error('Firmware response is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Firmware download stream is unavailable.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > maxSize) throw new Error('Firmware response is too large.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export async function fetchApprovedRelease() {
  if (!firmwareReleaseUrl) throw new Error('An approved release service has not been configured.');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const record = JSON.parse(new TextDecoder().decode(await download(firmwareReleaseUrl, 65536, controller.signal)));
    if (record.schema !== 1 || record.product !== 'NHR10-B' || record.hardware !== 'REV-B' || !valid(record.version) ||
        !/^[a-fA-F0-9]{64}$/.test(record.package_sha256) || !Number.isInteger(record.size) || record.size < 396 || record.size > MAX_OTA_IMAGE_SIZE + 108 ||
        typeof record.url !== 'string' || (record.release_notes !== undefined && typeof record.release_notes !== 'string'))
      throw new Error('Invalid approved firmware release record.');
    const bytes = await download(record.url, record.size, controller.signal);
    if (bytes.length !== record.size || await sha256(bytes) !== record.package_sha256.toLowerCase()) throw new Error('Release package size or SHA-256 does not match the approved record.');
    const pkg = await parsePackage(bytes, `NHR10-B-${record.version}.nhrota`);
    if (pkg.version !== record.version) throw new Error('Package version differs from the approved release record.');
    return { ...pkg, source: 'release' as const, releaseNotes: record.release_notes ?? '' };
  } finally { clearTimeout(timer); }
}

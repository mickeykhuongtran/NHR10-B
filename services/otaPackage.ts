import { compare, valid } from 'semver';
import type { OtaInfo, OtaTransportKind } from './otaProtocol';

export const MAX_OTA_IMAGE_SIZE = 3 * 1024 * 1024;
export interface OtaPackage {
  bytes: Uint8Array; manifest: Uint8Array; image: Uint8Array; size: number;
  version: string; project: string; imageHash: string; packageHash: string;
  source: 'engineering' | 'release'; name: string; releaseNotes?: string;
}
export const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Firmware validation requires HTTPS or localhost and Web Crypto.');
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
function fixedText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  // Match firmware manifest validation, including safe descriptor text.
  if (end <= 0 || bytes.slice(end).some(b => b !== 0) || bytes.slice(0, end).some(b => b < 0x21 || b > 0x7e || b === 34 || b === 92))
    throw new Error('Invalid package text or zero padding.');
  return new TextDecoder().decode(bytes.slice(0, end));
}
export async function parsePackage(input: ArrayBuffer | Uint8Array, name = 'firmware.nhrota'): Promise<OtaPackage> {
  const bytes = (input instanceof Uint8Array ? input : new Uint8Array(input)).slice();
  if (bytes.length < 396) throw new Error('Package is truncated. Select a complete .nhrota file.');
  const view = new DataView(bytes.buffer);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'NHR1' || bytes[4] !== 1 || bytes[5] !== 1 || bytes[6] !== 2 || bytes[7] !== 0)
    throw new Error('Not an NHR10-B REV-B .nhrota package. Raw BIN, ZIP and factory images are not supported.');
  const size = view.getUint32(8, true);
  if (size < 288 || size > MAX_OTA_IMAGE_SIZE || bytes.length !== 108 + size) throw new Error('Package size does not match the application image.');
  const version = fixedText(bytes.slice(44, 76)), project = fixedText(bytes.slice(76, 108));
  if (!valid(version)) throw new Error('Package version must be a valid semantic version.');
  const image = bytes.slice(108);
  const imageHash = await sha256(image);
  if (imageHash !== hex(bytes.slice(12, 44))) throw new Error('Package image SHA-256 mismatch. Obtain a correct package.');
  const descriptor = new DataView(image.buffer);
  if (image[0] !== 0xe9 || descriptor.getUint16(12, true) !== 9 || descriptor.getUint32(32, true) !== 0xabcd5432 ||
      fixedText(image.slice(48, 80)) !== version || fixedText(image.slice(80, 112)) !== project)
    throw new Error('ESP32-S3 application descriptor does not match the package.');
  return { bytes, manifest: bytes.slice(0, 108), image, size, version, project, imageHash, packageHash: await sha256(bytes), source: 'engineering', name };
}
export function assertCompatible(pkg: OtaPackage, info: OtaInfo, transport: OtaTransportKind, allowDowngrade = false) {
  if (info.product !== 'NHR10-B' || info.hw !== 'REV-B' || info.protocol !== 1 || info.project !== pkg.project || pkg.size > info.slot_size)
    throw new Error('Package is incompatible with the device model, hardware, project or update slot.');
  if (info.charge_only !== false) throw new Error('Start normal device operation, then reconnect before updating.');
  if (info.pending !== false) throw new Error('The installed firmware is still awaiting startup confirmation. Wait for confirmation or rollback, then prepare the update again.');
  if (info.ready !== true) throw new Error('Device is not ready for OTA. Finish startup, turn off Tag Insurance and read RF power again. If RFID reports transport_desynchronized, fully power-cycle the reader and controller together, then check RFID before retrying.');
  if (!info.ota.split(',').map(s => s.trim()).includes(transport))
    throw new Error(`This firmware does not support ${transport.toUpperCase()} OTA. Select a supported transport.`);
  if (!valid(info.fw)) throw new Error('Installed firmware version is not valid semver. Check device firmware support.');
  const ordering = compare(pkg.version, info.fw);
  if (ordering === 0) throw new Error('This firmware version is already installed.');
  if (ordering < 0 && !(allowDowngrade && pkg.source === 'engineering')) throw new Error('Downgrade is disabled. Select a newer release or explicitly allow downgrade in Engineering mode.');
}

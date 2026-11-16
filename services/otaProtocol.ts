export const OTA_UUID = {
  service: '4e485200-10c0-4a01-8a01-000000000001',
  write: '4e485201-10c0-4a01-8a01-000000000001',
  status: '4e485202-10c0-4a01-8a01-000000000001',
  info: '4e485203-10c0-4a01-8a01-000000000001',
  ack: '4e485205-10c0-4a01-8a01-000000000001',
} as const;
export const OTA_OP = { manifest: 1, begin: 2, data: 3, finish: 4, abort: 5 } as const;
export type OtaTransportKind = 'ble';
export interface OtaInfo {
  product: string; hw: string; id: string; fw: string; project: string; protocol: number;
  max_frame: number; stream_window?: number; ota: string; usb?: string; profile?: string;
  slot_size: number; slot?: string; charge_only: boolean; ready: boolean; pending: boolean;
}
export interface OtaStatus { state: number; error: number; source: number; seq: number; offset: number; total: number }
export type OtaEvent = (event: string, detail?: Record<string, unknown>) => void;
export const OTA_RESULTS = [
  'OK',
  'Malformed update frame. Check client and firmware protocol compatibility.',
  'Device busy with another updater. Close the other updater and reconnect.',
  'Invalid update state. Reconnect and restart from the beginning.',
  'Wrong data offset. Reconnect and restart from the beginning.',
  'Wrong package, model or hardware. Select an NHR10-B REV-B package.',
  'Image too large for the device. Select a compatible package.',
  'Device not ready. Wait for startup checks, then reconnect.',
  'Power not sufficient. Keep the reader powered, check its battery/input and reconnect.',
  'Flash operation failed. Reconnect before retrying; export diagnostics if it persists.',
  'Image verification failed. Obtain a correct package; the current firmware remains selected.',
  'Update session timed out. Reconnect and restart from the beginning.',
  'Device disconnected. Reconnect and restart from the beginning.',
  'Update cancelled. The existing firmware remains selected.',
  'Device is in charge-only mode. Start normal operation before updating.',
  'Scan data could not be saved. Resolve or save the active operation before retrying.',
] as const;
export class OtaDeviceError extends Error {
  constructor(public code: number) { super(OTA_RESULTS[code] ?? `Unknown device result ${code}. Export diagnostics and contact support.`); }
}
export function parseStatus(data: ArrayBuffer | ArrayBufferView): OtaStatus {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length !== 20 || bytes[0] !== 78 || bytes[1] !== 83 || bytes[2] !== 1 || bytes[3] > 4 || bytes[6] > 2 || bytes[7] !== 0)
    throw new Error('Unsupported or malformed OTA status. Reconnect and check firmware compatibility.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { state: bytes[3], error: view.getUint16(4, true), source: bytes[6], seq: view.getUint32(8, true), offset: view.getUint32(12, true), total: view.getUint32(16, true) };
}
export function makeFrame(op: number, seq: number, offset = 0, payload = new Uint8Array()): Uint8Array {
  if (!Number.isInteger(op) || op < 1 || op > 5 || !Number.isInteger(seq) || seq < 1 || seq > 0xffffffff ||
      !Number.isInteger(offset) || offset < 0 || offset > 0xffffffff || payload.length > 500)
    throw new Error('Invalid OTA frame');
  const bytes = new Uint8Array(12 + payload.length);
  bytes.set([78, 85, 1, op]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, seq, true); view.setUint32(8, offset, true); bytes.set(payload, 12);
  return bytes;
}
export function parseInfo(data: ArrayBuffer | ArrayBufferView): OtaInfo {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!info || !/^NHR10-[0-9A-F]{12}$/.test(info.id) ||
      ['product', 'hw', 'fw', 'project', 'ota'].some(key => typeof info[key] !== 'string') ||
      ['charge_only', 'ready', 'pending'].some(key => typeof info[key] !== 'boolean') ||
      !Number.isInteger(info.protocol) || !Number.isInteger(info.max_frame) || info.max_frame < 20 || info.max_frame > 512 ||
      !Number.isInteger(info.slot_size) || info.slot_size <= 0)
    throw new Error('Device returned invalid OTA information. Reconnect and check firmware support.');
  return info;
}
export const otaSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function withTimeout<T>(work: Promise<T>, ms: number, message: string, retire?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { retire?.(); reject(new Error(message)); }, ms);
    })]);
  } finally { clearTimeout(timer!); }
}
export interface OtaTransport {
  readonly kind: OtaTransportKind;
  readonly source: number;
  readonly disconnected: boolean;
  info(): Promise<OtaInfo>;
  status(timeout?: number): Promise<OtaStatus>;
  write(frame: Uint8Array): Promise<void>;
  waitStatus(accept: (status: OtaStatus) => boolean, timeout: number, cancelled: () => boolean): Promise<OtaStatus>;
  reconnect(): Promise<OtaInfo>;
  close(): Promise<void>;
  disconnect(): void;
}

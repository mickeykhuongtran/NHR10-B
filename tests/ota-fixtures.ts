import { webcrypto } from 'node:crypto';
import type { OtaInfo, OtaStatus, OtaTransport } from '../services/otaProtocol';
export const testInfo: OtaInfo = { product: 'NHR10-B', hw: 'REV-B', id: 'NHR10-28848586593C', fw: '1.2.0-dev.1', project: 'gatt_server_demos', protocol: 1, max_frame: 182, stream_window: 1, ota: 'ble', usb: 'none', slot_size: 3145728, ready: true, pending: false, charge_only: false };
export async function packageBytes(version = '1.2.0-dev.2') {
  const bytes = new Uint8Array(108 + 901), view = new DataView(bytes.buffer);
  bytes.set([78, 72, 82, 49, 1, 1, 2, 0]); view.setUint32(8, 901, true);
  bytes.set(new TextEncoder().encode(version), 44); bytes.set(new TextEncoder().encode('gatt_server_demos'), 76);
  bytes[108] = 0xe9; view.setUint16(108 + 12, 9, true); view.setUint32(108 + 32, 0xabcd5432, true);
  bytes.set(new TextEncoder().encode(version), 108 + 48); bytes.set(new TextEncoder().encode('gatt_server_demos'), 108 + 80);
  bytes.set(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes.slice(108))), 12);
  return bytes;
}
export function statusBytes(status: OtaStatus) {
  const bytes = new Uint8Array(20), view = new DataView(bytes.buffer);
  bytes.set([78, 83, 1, status.state]); view.setUint16(4, status.error, true); bytes[6] = status.source;
  view.setUint32(8, status.seq, true); view.setUint32(12, status.offset, true); view.setUint32(16, status.total, true);
  return bytes;
}
export class FakeTransport implements OtaTransport {
  kind: 'ble' = 'ble'; source = 1; disconnected = false;
  currentInfo = { ...testInfo }; bootInfo = { ...testInfo, fw: '1.2.0-dev.2' };
  snapshot: OtaStatus = { state: 0, error: 0, source: 0, seq: 0, offset: 0, total: 0 };
  writes: Uint8Array[] = []; image: number[] = []; closeCount = 0; disconnectCount = 0;
  async info() { return { ...this.currentInfo }; }
  async status() { return { ...this.snapshot }; }
  async write(frame: Uint8Array) {
    this.writes.push(frame.slice()); const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    this.snapshot.seq = view.getUint32(4, true); this.snapshot.source = this.source;
    switch (frame[3]) {
      case 1: this.snapshot.state = 1; this.snapshot.offset += frame.length - 12; break;
      case 2: this.snapshot.state = 2; this.snapshot.total = 901; this.snapshot.offset = 0; break;
      case 3: this.snapshot.offset += frame.length - 12; this.image.push(...frame.slice(12)); break;
      case 4: this.snapshot.state = 3; break;
      case 5: this.snapshot.state = 4; this.snapshot.error = 13; break;
    }
  }
  async waitStatus(accept: (s: OtaStatus) => boolean) { const status = await this.status(); if (!accept(status)) throw new Error('No ACK'); return status; }
  async reconnect() { this.currentInfo = { ...this.bootInfo }; return this.info(); }
  async close() { this.closeCount++; }
  disconnect() { this.disconnectCount++; this.disconnected = true; }
}

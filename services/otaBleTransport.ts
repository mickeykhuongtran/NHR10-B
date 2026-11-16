import type { BluetoothRemoteGATTCharacteristic, OtaBleSession } from './bleService';
import { OTA_UUID, OtaEvent, OtaInfo, OtaStatus, OtaTransport, otaSleep, parseInfo, parseStatus } from './otaProtocol';

/** Window 1, write-with-response plus durable acknowledgement. No DATA retries. */
export class OtaBleTransport implements OtaTransport {
  readonly kind = 'ble' as const;
  readonly source = 1;
  disconnected = false;
  private writer?: BluetoothRemoteGATTCharacteristic;
  private statusReader?: BluetoothRemoteGATTCharacteristic;
  private infoReader?: BluetoothRemoteGATTCharacteristic;
  private ackReader?: BluetoothRemoteGATTCharacteristic;
  private latestAck?: OtaStatus;
  private notificationError?: Error;
  private pending = new Set<(error: Error) => void>();
  private wake?: () => void;
  private disconnectListener = () => {
    this.invalidate(new Error('BLE disconnected. Reconnect and restart from the beginning.'));
    this.event('disconnected', { transport: 'ble' });
  };
  private ackListener = (event: Event) => {
    try { this.latestAck = parseStatus((event.target as BluetoothRemoteGATTCharacteristic).value!); }
    catch (error) { this.notificationError = error as Error; }
    this.wake?.();
  };
  constructor(private session: OtaBleSession, private event: OtaEvent = () => {}, private timeout = 10000) {}
  private invalidate(error: Error) {
    this.disconnected = true;
    for (const fail of this.pending) fail(error);
    this.wake?.();
  }
  private operation<T>(name: string, work: () => Promise<T>, timeout = this.timeout): Promise<T> {
    if (this.disconnected) return Promise.reject(new Error('BLE session retired. Reconnect before retrying.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return; settled = true;
        clearTimeout(timer); this.pending.delete(fail);
        if (error) reject(error); else resolve(value!);
      };
      const fail = (error: Error) => finish(error);
      const timer = setTimeout(() => {
        this.event('gatt-timeout', { operation: name });
        this.invalidate(new Error(`BLE ${name} timed out. Reconnect and restart from the beginning.`));
        this.session.device?.gatt?.disconnect();
      }, timeout);
      this.pending.add(fail);
      Promise.resolve().then(() => { if (!settled) return work(); }).then(value => finish(undefined, value), fail);
    });
  }
  async open(): Promise<OtaInfo> {
    if (!this.session.device) throw new Error('Connect the reader with the controller Bluetooth button first.');
    this.disconnected = false;
    this.latestAck = undefined; this.notificationError = undefined;
    this.session.device.removeEventListener('gattserverdisconnected', this.disconnectListener);
    this.session.device.addEventListener('gattserverdisconnected', this.disconnectListener);
    const server = await this.operation('connect', () => this.session.getServer());
    const service = await this.operation('service discovery', () => server.getPrimaryService(OTA_UUID.service)).catch(error => {
      if (error instanceof DOMException && error.name === 'SecurityError')
        throw new Error('Bluetooth permission does not include firmware updates. Disconnect and select the reader again using Connect device.');
      if (error instanceof DOMException && error.name === 'NotFoundError')
        throw new Error('This reader does not expose BLE firmware updates. Install the OTA-enabled REV-B application and bootloader once through the programming connection.');
      throw error;
    });
    const characteristic = (uuid: string) => this.operation('characteristic discovery', () => service.getCharacteristic(uuid));
    this.writer = await characteristic(OTA_UUID.write);
    this.statusReader = await characteristic(OTA_UUID.status);
    this.infoReader = await characteristic(OTA_UUID.info);
    if (!this.writer.writeValueWithResponse || !this.statusReader.readValue || !this.infoReader.readValue)
      throw new Error('Required OTA characteristics are unavailable. Reconnect using the device picker to grant OTA access.');
    const info = await this.info();
    this.ackReader?.removeEventListener('characteristicvaluechanged', this.ackListener);
    this.ackReader = undefined;
    try { this.ackReader = await characteristic(OTA_UUID.ack); }
    catch (error) {
      // Older protocol-v1 implementations can use durable status polling.
      if (this.disconnected || !(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
      this.event('ack-unavailable', { fallback: 'durable-status' });
    }
    if (this.ackReader) {
      this.ackReader.addEventListener('characteristicvaluechanged', this.ackListener);
      await this.operation('ACK subscription', () => this.ackReader!.startNotifications());
    }
    return info;
  }
  async info() { return parseInfo(await this.operation('info read', () => this.infoReader!.readValue!())); }
  async status(timeout?: number) { return parseStatus(await this.operation('status read', () => this.statusReader!.readValue!(), timeout)); }
  async write(frame: Uint8Array) { await this.operation('write', () => this.writer!.writeValueWithResponse!(frame)); }
  async waitStatus(accept: (status: OtaStatus) => boolean, timeout: number, cancelled: () => boolean) {
    const deadline = Date.now() + timeout; let pollAt = Date.now() + (this.ackReader ? 500 : 0);
    while (Date.now() < deadline) {
      if (cancelled()) throw new Error('Cancelled');
      if (this.disconnected) throw new Error('BLE disconnected. Reconnect and restart from the beginning.');
      if (this.notificationError) throw this.notificationError;
      if (this.latestAck && accept(this.latestAck)) return this.latestAck;
      if (Date.now() >= pollAt) {
        const status = await this.status(Math.min(this.timeout, Math.max(1, deadline - Date.now())));
        if (accept(status)) return status;
        pollAt = Date.now() + 500;
      }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); if (this.wake === done) this.wake = undefined; resolve(); };
        const timer = setTimeout(done, Math.min(100, Math.max(1, deadline - Date.now())));
        this.wake = done;
      });
    }
    throw new Error('No durable acknowledgement. Reconnect and restart; the DATA frame was not retransmitted.');
  }
  async reconnect() {
    // FINISH reboots after about 1.5 s. Drop the old link before reading Info.
    this.session.device?.gatt?.disconnect();
    await otaSleep(2300);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try { return await this.open(); }
      catch { this.session.device?.gatt?.disconnect(); await otaSleep(800); }
    }
    throw new Error('BLE reconnect failed. Restore power, reconnect the same reader and check its running firmware.');
  }
  disconnect() {
    this.event('disconnect-request', { transport: 'ble' });
    this.invalidate(new Error('BLE connection closed.'));
    this.session.device?.gatt?.disconnect();
  }
  async close() {
    this.ackReader?.removeEventListener('characteristicvaluechanged', this.ackListener);
    if (!this.disconnected && this.session.device?.gatt?.connected && this.ackReader?.stopNotifications) {
      try { await this.operation('stop ACK notifications', () => this.ackReader!.stopNotifications!()); } catch { /* Lease release handles failed links. */ }
    }
    this.session.device?.removeEventListener('gattserverdisconnected', this.disconnectListener);
    this.invalidate(new Error('OTA session released.'));
    // The RFID manager retains ownership of the physical connection.
  }
}

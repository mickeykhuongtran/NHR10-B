import { ConnectionStatus } from '../types';
import { assertValidBleDeviceName } from '../utils/deviceName';

// --- Web Bluetooth Type Definitions ---
interface BluetoothDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BluetoothRemoteGATTServer;
}

interface BluetoothRemoteGATTServer {
  device: BluetoothDevice;
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: string | number): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(characteristic: string | number): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothCharacteristicProperties {
  read?: boolean;
  write?: boolean;
  writeWithoutResponse?: boolean;
  notify?: boolean;
  indicate?: boolean;
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  properties?: BluetoothCharacteristicProperties;
  value?: DataView;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
}
// --------------------------------------

const SERVICE_UUID = '000000ff-0000-1000-8000-00805f9b34fb';
const CHAR_CMD_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';
const CHAR_FILE_REQ_UUID = '0000ff02-0000-1000-8000-00805f9b34fb';
const CHAR_FILE_DATA_UUID = '0000ff03-0000-1000-8000-00805f9b34fb';
const JSON_FRAME_START = 0x7B; // '{'
const LIVE_TAGS_MAGIC_0 = 0x4E; // 'N'
const LIVE_TAGS_MAGIC_1 = 0x48; // 'H'
const LIVE_TAGS_VERSION = 1;
const LIVE_TAGS_TYPE = 1;
const LIVE_TAGS_DELIVERY_INTERVAL_MS = 100;
const COMMAND_WRITE_GAP_MS = 85;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const;
const IDENTITY_RESPONSE_TIMEOUT_MS = 3000;
const UNPAIR_ACK_DEADLINE_MS = 500;
const UNPAIR_ACK_RETRY_DELAYS_MS = [0, 20, 40, 80, 120] as const;
const PERSISTED_DEVICE_STORAGE_KEYS = [
  'lastConnectedDevice',
  'nhr10.lastConnectedDevice',
  'nhr10:lastConnectedDevice',
  'autoConnectDevice',
  'nhr10.autoConnectDevice',
  'nhr10:autoConnectDevice',
] as const;

export type BleDeviceIdentity = {
  canonicalId: string;
  displayId: string;
  advertisedName: string;
  model: string;
  firmware: string;
  hardware: string;
  manufacturer: string;
};

type LiveTagsItem = [string, number, number, number];
type LiveTagsPayload = {
  cmd: 'live_tags';
  seq: number;
  d: LiveTagsItem[];
};

// Callbacks
type DataCallback = (data: any) => void;
type LogCallback = (msg: string, type: 'info' | 'error' | 'rx' | 'tx') => void;
type FileTransferEvent = 'request' | 'start' | 'progress' | 'complete' | 'busy' | 'error';
type FileTransferCallback = (event: FileTransferEvent, data?: any) => void;
type ConnectionCallback = (status: ConnectionStatus, reason?: string) => void;
type PendingIdentityVerification = {
  resolve: (identity: BleDeviceIdentity | null) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};
type RequestDeviceOptions = {
  acceptAllDevices?: boolean;
  filters?: Array<{ namePrefix?: string; services?: string[] }>;
  optionalServices: string[];
};

type NhrbStartMetadata = {
  cmd: 'START';
  format: 'NHRB';
  version: number;
  size: number;
  chunks: number;
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

class BLEService {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private service: BluetoothRemoteGATTService | null = null;
  private charCmd: BluetoothRemoteGATTCharacteristic | null = null;
  private charFileReq: BluetoothRemoteGATTCharacteristic | null = null;
  private charFileData: BluetoothRemoteGATTCharacteristic | null = null;

  private onDataReceived: DataCallback | null = null;
  private onLog: LogCallback | null = null;
  private onFileTransfer: FileTransferCallback | null = null;
  private onConnectionStatus: ConnectionCallback | null = null;
  private identity: BleDeviceIdentity | null = null;
  private pendingIdentityVerification: PendingIdentityVerification | null = null;
  private shouldReconnect = false;
  private reconnectGeneration = 0;
  private cancelReconnectDelay: (() => void) | null = null;
  private intentionalUnpair = false;

  // File Transfer State
  private isFileTransferring = false;
  private fileChunks: Map<number, Uint8Array> = new Map();
  private fileTotalSize = 0;
  private fileReceivedSize = 0;
  private fileExpectedChunks = 0;
  private fileSeqEndian: 'little' | 'big' | null = null;

  // Command Queue to prevent GATT collisions
  private commandQueue: Promise<void> = Promise.resolve();
  private commandQueueGeneration = 0;
  private lastCommandWriteAt = 0;
  private acceptLiveTags = false;
  private liveTagsFlushTimer: number | null = null;
  private liveTagsLastFlushAt = 0;
  private pendingLiveTagsSeq = 0;
  private pendingLiveTags: Map<string, LiveTagsItem> = new Map();

  // Bound handler for file notifications
  private boundFileHandler = this.handleFileNotification.bind(this);
  private boundCmdHandler = this.handleCmdNotification.bind(this);
  private boundDisconnectHandler = this.handleDisconnect.bind(this);

  constructor() {}

  setCallbacks(
    onData: DataCallback,
    onLog: LogCallback,
    onFileTransfer: FileTransferCallback,
    onConnectionStatus?: ConnectionCallback,
  ) {
    this.onDataReceived = onData;
    this.onLog = onLog;
    this.onFileTransfer = onFileTransfer;
    this.onConnectionStatus = onConnectionStatus ?? null;
  }

  async connect(): Promise<void> {
    const nav = navigator as any;
    if (!nav.bluetooth) {
      throw new Error('Web Bluetooth is not supported in this browser.');
    }

    this.log('Requesting device...', 'info');

    try {
      this.disconnect();
      this.intentionalUnpair = false;
      const connectionGeneration = this.reconnectGeneration;
      const selectedDevice = await this.requestDevice(nav);
      if (connectionGeneration !== this.reconnectGeneration) {
        throw new Error('BLE connection request was cancelled');
      }

      this.device = selectedDevice;
      this.device.addEventListener('gattserverdisconnected', this.boundDisconnectHandler);
      await this.connectGatt(false, connectionGeneration);
    } catch (error: any) {
      if (!this.intentionalUnpair) {
        this.disconnect();
      }
      this.log(`Connection failed: ${error.message}`, 'error');
      throw error;
    }
  }

  private async requestDevice(nav: any): Promise<BluetoothDevice> {
    const filteredOptions: RequestDeviceOptions = {
      filters: [
        { services: [SERVICE_UUID] },
        { namePrefix: 'NHR10-' },
        { namePrefix: 'NHR-10' },
        { namePrefix: 'Nextwaves' },
      ],
      optionalServices: [SERVICE_UUID],
    };

    try {
      return await nav.bluetooth.requestDevice(filteredOptions);
    } catch (error: any) {
      const message = String(error?.message ?? error ?? '');
      const shouldRetryForBluefy = /payload|parse|parsed|requestdevice/i.test(message);
      if (!shouldRetryForBluefy) {
        throw error;
      }

      this.log('Retrying BLE request with iOS-compatible selector...', 'info');
      return nav.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [SERVICE_UUID],
      });
    }
  }

  disconnect() {
    const device = this.device;
    this.shouldReconnect = false;
    this.reconnectGeneration += 1;
    this.cancelScheduledReconnect();
    device?.removeEventListener('gattserverdisconnected', this.boundDisconnectHandler);
    if (device?.gatt?.connected) {
      device.gatt.disconnect();
    }
    this.clearConnectionState();
    this.intentionalUnpair = false;
  }

  private async connectGatt(isReconnect: boolean, connectionGeneration: number): Promise<void> {
    const device = this.device;
    if (!device?.gatt) {
      throw new Error('Selected device does not expose a GATT server.');
    }

    this.log(`${isReconnect ? 'Reconnecting' : 'Connecting'} to ${device.name ?? 'NHR-10'}...`, 'info');
    this.server = await device.gatt.connect();
    this.assertConnectionAttemptIsCurrent(device, connectionGeneration);

    this.log('Getting Service...', 'info');
    this.service = await this.server.getPrimaryService(SERVICE_UUID);
    this.assertConnectionAttemptIsCurrent(device, connectionGeneration);

    this.log('Getting Characteristics...', 'info');
    this.charCmd = await this.service.getCharacteristic(CHAR_CMD_UUID);
    this.charFileReq = await this.service.getCharacteristic(CHAR_FILE_REQ_UUID);
    this.charFileData = await this.service.getCharacteristic(CHAR_FILE_DATA_UUID);
    this.assertConnectionAttemptIsCurrent(device, connectionGeneration);
    this.log(`FF01 properties: ${this.formatCharacteristicProperties(this.charCmd)}`, 'info');

    this.log('Starting Notifications...', 'info');
    await this.charCmd.startNotifications();
    this.charCmd.addEventListener('characteristicvaluechanged', this.boundCmdHandler);
    this.assertConnectionAttemptIsCurrent(device, connectionGeneration);

    await this.requestAndValidateIdentity(device);
    this.assertConnectionAttemptIsCurrent(device, connectionGeneration);
    this.shouldReconnect = true;
    this.log(isReconnect ? 'Reconnected and ready.' : 'Connected and ready.', 'info');
  }

  private handleDisconnect(event: Event) {
    const disconnectedDevice = event.target as BluetoothDevice;
    if (disconnectedDevice !== this.device) return;

    const shouldAttemptReconnect = this.shouldReconnect;
    this.shouldReconnect = false;
    this.cancelScheduledReconnect();
    this.clearGattState();

    if (this.intentionalUnpair) {
      this.intentionalUnpair = false;
      this.clearConnectionState();
      this.log('Device-initiated unpair completed.', 'info');
      this.onConnectionStatus?.('disconnected', 'Device unpaired. Scan and select it again to reconnect.');
      return;
    }

    if (!shouldAttemptReconnect) {
      this.clearConnectionState();
      this.onConnectionStatus?.('disconnected', 'BLE connection closed');
      return;
    }

    this.log('Device disconnected unexpectedly.', 'error');
    this.onConnectionStatus?.('disconnected', 'BLE link lost');

    const reconnectGeneration = ++this.reconnectGeneration;
    void this.reconnectDevice(disconnectedDevice, reconnectGeneration);
  }

  private async reconnectDevice(device: BluetoothDevice, reconnectGeneration: number): Promise<void> {
    let lastError = 'device unavailable';

    for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt += 1) {
      const delayCompleted = await this.waitForReconnectDelay(RECONNECT_DELAYS_MS[attempt]);
      if (!delayCompleted || this.device !== device || this.reconnectGeneration !== reconnectGeneration) return;

      this.onConnectionStatus?.('connecting', `Reconnect attempt ${attempt + 1}/${RECONNECT_DELAYS_MS.length}`);
      try {
        await this.connectGatt(true, reconnectGeneration);
        if (this.device !== device || this.reconnectGeneration !== reconnectGeneration) return;
        this.onConnectionStatus?.('connected');
        return;
      } catch (error: any) {
        if (this.intentionalUnpair || this.device !== device || this.reconnectGeneration !== reconnectGeneration) return;
        lastError = String(error?.message ?? error ?? lastError);
        this.clearGattState();
        this.log(`Reconnect attempt ${attempt + 1} failed: ${lastError}`, 'error');
      }
    }

    if (this.device !== device || this.reconnectGeneration !== reconnectGeneration) return;
    this.disconnect();
    this.onConnectionStatus?.('error', `BLE reconnect failed: ${lastError}`);
  }

  private assertConnectionAttemptIsCurrent(device: BluetoothDevice, connectionGeneration: number) {
    if (
      this.intentionalUnpair ||
      this.device !== device ||
      this.reconnectGeneration !== connectionGeneration
    ) {
      throw new Error('BLE connection attempt was cancelled');
    }
  }

  private waitForReconnectDelay(delayMs: number): Promise<boolean> {
    this.cancelScheduledReconnect();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        this.cancelReconnectDelay = null;
        resolve(completed);
      };
      const timeoutId = window.setTimeout(() => finish(true), delayMs);
      this.cancelReconnectDelay = () => {
        window.clearTimeout(timeoutId);
        finish(false);
      };
    });
  }

  private cancelScheduledReconnect() {
    const cancel = this.cancelReconnectDelay;
    this.cancelReconnectDelay = null;
    cancel?.();
  }

  private async requestAndValidateIdentity(device: BluetoothDevice): Promise<void> {
    if (this.pendingIdentityVerification) {
      throw new Error('NHR-10 identity verification failed: another verification is already active');
    }

    const advertisedName = device.name?.trim() ?? '';
    const requiresCanonicalIdentity = this.requiresCanonicalIdentity(advertisedName);
    const identityPromise = new Promise<BleDeviceIdentity | null>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (!this.pendingIdentityVerification) return;

        if (requiresCanonicalIdentity) {
          this.settleIdentityVerification(
            null,
            new Error('NHR-10 identity verification failed: DI response timed out'),
          );
          return;
        }

        this.log('Legacy device did not return a verifiable DI identity; continuing in compatibility mode.', 'info');
        this.settleIdentityVerification(null);
      }, IDENTITY_RESPONSE_TIMEOUT_MS);

      this.pendingIdentityVerification = { resolve, reject, timeoutId };
    });

    try {
      await this.sendCommand({ cmd: 'DI' });
    } catch (error: any) {
      this.settleIdentityVerification(
        null,
        new Error(`NHR-10 identity verification failed: unable to request DI: ${error.message}`),
      );
    }

    await identityPromise;
  }

  private settleIdentityVerification(identity: BleDeviceIdentity | null, error?: Error): boolean {
    const pending = this.pendingIdentityVerification;
    if (!pending) return false;

    window.clearTimeout(pending.timeoutId);
    this.pendingIdentityVerification = null;
    if (error) pending.reject(error);
    else pending.resolve(identity);
    return true;
  }

  private parseDeviceIdentityResponse(data: any): BleDeviceIdentity | null {
    const advertisedName = this.device?.name?.trim() ?? '';
    const requiresCanonicalIdentity = this.requiresCanonicalIdentity(advertisedName);
    if (typeof data?.id !== 'string' || data.id.trim() === '') {
      if (requiresCanonicalIdentity) {
        throw new Error('DI response is missing Canonical ID');
      }

      this.log('Legacy DI response has no Canonical ID; using compatibility mode.', 'info');
      return null;
    }

    const canonicalId = data.id.trim().toUpperCase();
    if (!/^NHR10-[0-9A-F]{12}$/.test(canonicalId)) {
      throw new Error(`DI returned invalid Canonical ID "${data.id}"`);
    }

    const displayId = canonicalId.slice(-6);
    const responseDisplayId = typeof data.display_id === 'string'
      ? data.display_id.trim().toUpperCase()
      : displayId;
    if (responseDisplayId !== displayId) {
      throw new Error(`DI Display ID ${responseDisplayId} does not match ${canonicalId}`);
    }
    if (this.identity && this.identity.canonicalId !== canonicalId) {
      throw new Error(`DI identity ${canonicalId} does not match ${this.identity.canonicalId}`);
    }

    const advertisedMatch = /^NHR10-([0-9A-F]{6})$/i.exec(advertisedName);
    if (advertisedMatch && advertisedMatch[1].toUpperCase() !== displayId) {
      throw new Error(`DI identity ${canonicalId} does not match advertised name ${advertisedName}`);
    }

    const model = typeof data.val === 'string' && data.val.trim() ? data.val.trim() : 'NHR-10';
    if (model !== 'NHR-10') {
      throw new Error(`DI returned unexpected model "${model}"`);
    }

    return {
      canonicalId,
      displayId,
      advertisedName,
      model,
      firmware: typeof data.fw === 'string' ? data.fw.trim() : this.identity?.firmware ?? '',
      hardware: typeof data.hw === 'string' ? data.hw.trim() : this.identity?.hardware ?? '',
      manufacturer: this.identity?.manufacturer ?? '',
    };
  }

  private requiresCanonicalIdentity(advertisedName: string): boolean {
    if (this.identity !== null) return true;

    // A configured GAP name no longer carries the NHR10-xxxxxx suffix. Keep
    // DI mandatory for custom/service-selected devices; compatibility mode is
    // reserved for the explicitly supported legacy advertising families.
    return !/^(?:NHR-10|Nextwaves(?:_Scanner_V3)?)$/i.test(advertisedName);
  }

  private rejectIdentity(reason: string) {
    const message = `NHR-10 identity verification failed: ${reason}`;
    this.log(message, 'error');
    this.onConnectionStatus?.('error', message);
    this.disconnect();
  }

  getDeviceName(): string {
    return this.device?.name ?? '';
  }

  getDeviceIdentity(): BleDeviceIdentity | null {
    return this.identity ? { ...this.identity } : null;
  }

  isIntentionalUnpairPending(): boolean {
    return this.intentionalUnpair;
  }

  recoverFromUnexpectedLinkTimeout(reason = 'BLE link timeout'): boolean {
    if (this.intentionalUnpair || !this.shouldReconnect || !this.device?.gatt) return false;

    this.log(`${reason}; restarting the bounded reconnect policy.`, 'error');
    if (this.device.gatt.connected) {
      // Keep the disconnect listener installed: the resulting event follows
      // the same bounded reconnect path as a radio/link-layer loss.
      this.device.gatt.disconnect();
      return true;
    }

    return false;
  }

  private clearConnectionState() {
    this.device?.removeEventListener('gattserverdisconnected', this.boundDisconnectHandler);
    this.clearGattState();
    this.shouldReconnect = false;
    this.identity = null;
    this.device = null;
  }

  private clearGattState() {
    this.settleIdentityVerification(
      null,
      new Error('NHR-10 identity verification failed: BLE link closed before DI verification completed'),
    );
    this.charCmd?.removeEventListener('characteristicvaluechanged', this.boundCmdHandler);
    this.charFileData?.removeEventListener('characteristicvaluechanged', this.boundFileHandler);
    this.resetFileState();
    this.commandQueueGeneration += 1;
    this.commandQueue = Promise.resolve();
    this.lastCommandWriteAt = 0;
    this.acceptLiveTags = false;
    this.clearPendingLiveTags();
    this.server = null;
    this.service = null;
    this.charCmd = null;
    this.charFileReq = null;
    this.charFileData = null;
  }

  private resetFileState() {
    this.isFileTransferring = false;
    this.fileChunks.clear();
    this.fileTotalSize = 0;
    this.fileReceivedSize = 0;
    this.fileExpectedChunks = 0;
    this.fileSeqEndian = null;
  }

  suspendLiveTags() {
    this.acceptLiveTags = false;
    this.clearPendingLiveTags();
  }

  resumeLiveTags() {
    this.clearPendingLiveTags();
    this.acceptLiveTags = true;
  }

  private clearPendingLiveTags() {
    if (this.liveTagsFlushTimer !== null) {
      window.clearTimeout(this.liveTagsFlushTimer);
      this.liveTagsFlushTimer = null;
    }

    this.pendingLiveTags.clear();
    this.pendingLiveTagsSeq = 0;
  }

  private enqueueLiveTags(data: LiveTagsPayload) {
    if (!this.acceptLiveTags) return;

    data.d.forEach(([epc, rssi, countDelta, totalCount]) => {
      const existing = this.pendingLiveTags.get(epc);
      const mergedDelta = (existing?.[2] ?? 0) + countDelta;
      this.pendingLiveTags.set(epc, [epc, rssi, mergedDelta, totalCount]);
    });

    this.pendingLiveTagsSeq = data.seq;
    this.scheduleLiveTagsFlush();
  }

  private scheduleLiveTagsFlush() {
    if (this.liveTagsFlushTimer !== null) return;

    const elapsedMs = Date.now() - this.liveTagsLastFlushAt;
    const delayMs = Math.max(0, LIVE_TAGS_DELIVERY_INTERVAL_MS - elapsedMs);
    this.liveTagsFlushTimer = window.setTimeout(() => {
      this.liveTagsFlushTimer = null;
      this.flushLiveTags();
    }, delayMs);
  }

  private flushLiveTags() {
    if (!this.acceptLiveTags || this.pendingLiveTags.size === 0) {
      this.clearPendingLiveTags();
      return;
    }

    const payload: LiveTagsPayload = {
      cmd: 'live_tags',
      seq: this.pendingLiveTagsSeq,
      d: Array.from(this.pendingLiveTags.values()),
    };

    this.pendingLiveTags.clear();
    this.pendingLiveTagsSeq = 0;
    this.liveTagsLastFlushAt = Date.now();
    if (this.onDataReceived) {
      this.onDataReceived(payload);
    }
  }

  private handleCmdNotification(event: Event) {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const view = target.value;
    if (!view || view.byteLength === 0) return;

    const firstByte = view.getUint8(0);

    if (firstByte === JSON_FRAME_START) {
      this.handleJsonCmdNotification(view);
      return;
    }

    if (
      view.byteLength >= 2 &&
      firstByte === LIVE_TAGS_MAGIC_0 &&
      view.getUint8(1) === LIVE_TAGS_MAGIC_1
    ) {
      if (!this.acceptLiveTags) {
        return;
      }

      const data = this.parseBinaryLiveTags(view);
      if (data) {
        this.enqueueLiveTags(data);
      }
      return;
    }

    this.log(`RX (Unknown ${view.byteLength} bytes): ${this.formatHexPreview(view)}`, 'rx');
  }

  private handleJsonCmdNotification(view: DataView) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const decoder = new TextDecoder('utf-8');
    const value = decoder.decode(bytes);
    
    try {
      const data = JSON.parse(value);

      if (data?.cmd === 'UQ' && data?.v === 1) {
        this.handleDeviceUnpairRequest(data, value);
        return;
      }

      if (data.cmd === 'DI') {
        const hasPendingVerification = this.pendingIdentityVerification !== null;
        try {
          const identity = this.parseDeviceIdentityResponse(data);
          if (identity) {
            this.identity = identity;
            this.log(`Verified device identity via DI: ${identity.canonicalId}`, 'info');
          }
          this.settleIdentityVerification(identity);
        } catch (error: any) {
          const message = String(error?.message ?? error ?? 'invalid DI response');
          const verificationError = new Error(`NHR-10 identity verification failed: ${message}`);
          if (hasPendingVerification) {
            this.settleIdentityVerification(null, verificationError);
          } else {
            this.rejectIdentity(message);
          }
          return;
        }
      }

      if (data.cmd === 'live_tags') {
        if (!this.acceptLiveTags) {
          return;
        }

        if (Array.isArray(data.d)) {
          this.enqueueLiveTags(data);
        }
        return;
      }

      if (data.cmd === 'live_tag' && !this.acceptLiveTags) {
        return;
      }

      if (this.onDataReceived) {
        this.onDataReceived(data);
      }

      if (data.cmd !== 'live_tag' && data.cmd !== 'live_tags') {
        this.log(`RX: ${value}`, 'rx');
      }
    } catch (e) {
      this.log(`RX (Invalid JSON): ${value}`, 'rx');
    }
  }

  private handleDeviceUnpairRequest(data: { cmd: 'UQ'; v: 1 }, rawValue: string) {
    if (this.intentionalUnpair) {
      this.log('RX: duplicate device unpair request ignored while ACK is pending', 'rx');
      return;
    }

    const requestedAt = performance.now();
    const queueToDrain = this.commandQueue;
    this.intentionalUnpair = true;
    this.shouldReconnect = false;
    this.reconnectGeneration += 1;
    this.cancelScheduledReconnect();
    this.settleIdentityVerification(
      null,
      new Error('NHR-10 identity verification cancelled by device unpair'),
    );
    this.suspendLiveTags();
    this.clearPersistedLastConnectedDevice();

    // Invalidate queued commands before issuing UA. An already executing Web
    // Bluetooth operation cannot be aborted, so the urgent writer retries as
    // soon as that operation drains instead of waiting behind the old queue.
    this.commandQueueGeneration += 1;
    this.commandQueue = Promise.resolve();
    const ackPromise = this.writeDeviceUnpairAck(requestedAt, queueToDrain);

    // ACK invocation above happens before any logging or React callback.
    this.log(`RX: ${rawValue}`, 'rx');
    this.onDataReceived?.(data);
    void ackPromise;
  }

  private async writeDeviceUnpairAck(requestedAt: number, queueToDrain: Promise<void>) {
    const characteristic = this.charCmd;
    if (!characteristic || typeof characteristic.writeValueWithResponse !== 'function') {
      this.log('Unable to acknowledge device unpair: FF01 write-with-response is unavailable', 'error');
      return;
    }

    const payloadText = JSON.stringify({ cmd: 'UA', v: 1 });
    const payload = new TextEncoder().encode(payloadText);
    let lastError = 'unknown GATT write error';

    for (let attempt = 0; attempt < UNPAIR_ACK_RETRY_DELAYS_MS.length; attempt += 1) {
      const elapsedBeforeAttempt = performance.now() - requestedAt;
      if (elapsedBeforeAttempt >= UNPAIR_ACK_DEADLINE_MS) break;

      const retryDelay = UNPAIR_ACK_RETRY_DELAYS_MS[attempt];
      if (retryDelay > 0) {
        await Promise.race([
          queueToDrain.catch(() => undefined),
          wait(Math.min(retryDelay, UNPAIR_ACK_DEADLINE_MS - elapsedBeforeAttempt)),
        ]);
      }

      if (!this.intentionalUnpair || !this.device?.gatt?.connected) break;

      try {
        await characteristic.writeValueWithResponse(payload);
        const elapsedMs = Math.round(performance.now() - requestedAt);
        this.lastCommandWriteAt = Date.now();
        this.log(`TX (writeWithResponse, ${payload.byteLength}B): ${payloadText}`, 'tx');
        this.log(`App acknowledged device-initiated unpair in ${elapsedMs} ms`, 'info');
        if (elapsedMs >= UNPAIR_ACK_DEADLINE_MS) {
          this.log(`Unpair ACK exceeded ${UNPAIR_ACK_DEADLINE_MS} ms deadline`, 'error');
        }
        return;
      } catch (error: any) {
        lastError = String(error?.message ?? error ?? lastError);
      }
    }

    const elapsedMs = Math.round(performance.now() - requestedAt);
    this.log(`Device unpair ACK failed after ${elapsedMs} ms: ${lastError}`, 'error');
  }

  private clearPersistedLastConnectedDevice() {
    const clearStorage = (storage: Storage) => {
      PERSISTED_DEVICE_STORAGE_KEYS.forEach((key) => storage.removeItem(key));
    };

    try {
      clearStorage(window.localStorage);
    } catch {
      // Storage can be unavailable in private/restricted browser contexts.
    }

    try {
      clearStorage(window.sessionStorage);
    } catch {
      // Session storage is best-effort; reconnect is also disabled in memory.
    }
  }

  private parseBinaryLiveTags(view: DataView): LiveTagsPayload | null {
    if (view.byteLength < 9) {
      this.log(`RX (Invalid live_tags frame: ${view.byteLength} bytes)`, 'error');
      return null;
    }

    const version = view.getUint8(2);
    const type = view.getUint8(3);
    if (version !== LIVE_TAGS_VERSION || type !== LIVE_TAGS_TYPE) {
      this.log(`RX (Unsupported live_tags frame v${version}, type ${type})`, 'error');
      return null;
    }

    const seq = view.getUint32(4, true);
    const itemCount = view.getUint8(8);
    const d: LiveTagsPayload['d'] = [];
    let offset = 9;

    for (let i = 0; i < itemCount; i++) {
      if (offset >= view.byteLength) {
        this.log(`RX (Invalid live_tags frame: missing item ${i + 1}/${itemCount})`, 'error');
        return null;
      }

      const epcLen = view.getUint8(offset);
      offset += 1;

      const itemBytes = epcLen + 1 + 2 + 4;
      if (epcLen <= 0 || offset + itemBytes > view.byteLength) {
        this.log(`RX (Invalid live_tags item ${i + 1}: epc_len=${epcLen})`, 'error');
        return null;
      }

      const epcBytes = new Uint8Array(view.buffer, view.byteOffset + offset, epcLen);
      const epc = this.bytesToHex(epcBytes);
      offset += epcLen;

      const rssi = view.getInt8(offset);
      offset += 1;

      const countDelta = view.getUint16(offset, true);
      offset += 2;

      const totalCount = view.getUint32(offset, true);
      offset += 4;

      d.push([epc, rssi, countDelta, totalCount]);
    }

    return { cmd: 'live_tags', seq, d };
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  private formatHexPreview(view: DataView, maxBytes = 24): string {
    const byteLength = Math.min(view.byteLength, maxBytes);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, byteLength);
    const suffix = view.byteLength > maxBytes ? '...' : '';
    return `${this.bytesToHex(bytes)}${suffix}`;
  }

  private handleFileNotification(event: Event) {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const view = target.value;
    if (!view || view.byteLength === 0) return;

    if (view.getUint8(0) === JSON_FRAME_START) {
      this.handleUnframedFileJson(view);
      return;
    }

    if (view.byteLength < 2) {
      this.failFileTransfer(`Invalid FF03 frame: ${view.byteLength} bytes`);
      return;
    }

    const headerBig = view.getUint16(0, false);
    const headerLittle = view.getUint16(0, true);
    const payload = this.copyPayload(view, 2);

    if (headerBig === 0xFFFF) {
      this.handleFileStartFrame(payload);
      return;
    }

    if (headerBig === 0xFFFE || headerLittle === 0xFFFE) {
      this.handleFileEofFrame(payload);
      return;
    }

    this.handleFileDataFrame(headerBig, headerLittle, payload);
  }

  private handleUnframedFileJson(view: DataView) {
    const payload = this.copyPayload(view, 0);
    const data = this.parseJsonPayload(payload);

    if (data?.err === 2 && data?.state === 'busy') {
      this.log('FF03 busy: device is still saving batch data', 'info');
      this.resetFileState();
      this.charFileData?.removeEventListener('characteristicvaluechanged', this.boundFileHandler);
      if (this.onFileTransfer) this.onFileTransfer('busy', data);
      return;
    }

    this.log(`RX (FF03 JSON): ${new TextDecoder('utf-8').decode(payload)}`, 'rx');
  }

  private handleFileStartFrame(payload: Uint8Array) {
    this.resetFileState();

    const metadata = this.parseJsonPayload(payload) as Partial<NhrbStartMetadata> | null;
    if (!metadata || metadata.cmd !== 'START') {
      this.failFileTransfer('Invalid START packet metadata');
      return;
    }

    if (metadata.format !== 'NHRB' || metadata.version !== 1) {
      this.failFileTransfer(`Unsupported batch file format: ${metadata.format ?? 'unknown'} v${metadata.version ?? 'unknown'}`);
      return;
    }

    const size = Number(metadata.size);
    const chunks = Number(metadata.chunks);
    if (!Number.isFinite(size) || size < 32 || !Number.isFinite(chunks) || chunks < 0) {
      this.failFileTransfer('Invalid NHRB START packet size/chunks');
      return;
    }

    this.isFileTransferring = true;
    this.fileTotalSize = Math.trunc(size);
    this.fileExpectedChunks = Math.trunc(chunks);

    if (this.onFileTransfer) {
      this.onFileTransfer('start', {
        format: metadata.format,
        version: metadata.version,
        total: this.fileTotalSize,
        chunks: this.fileExpectedChunks,
      });
    }
  }

  private handleFileDataFrame(seqBig: number, seqLittle: number, payload: Uint8Array) {
    if (!this.isFileTransferring) return;

    const seq = this.resolveFileSeq(seqBig, seqLittle);
    const existing = this.fileChunks.get(seq);
    if (existing) {
      this.fileReceivedSize -= existing.byteLength;
    }

    const chunk = payload.slice();
    this.fileChunks.set(seq, chunk);
    this.fileReceivedSize += chunk.byteLength;

    if (this.onFileTransfer && this.fileTotalSize > 0) {
      const percent = Math.min(99, Math.round((this.fileReceivedSize / this.fileTotalSize) * 100));
      this.onFileTransfer('progress', percent);
    }
  }

  private resolveFileSeq(seqBig: number, seqLittle: number): number {
    const expectedNextSeq = this.fileChunks.size;

    if (this.fileSeqEndian === null) {
      if (seqLittle === expectedNextSeq && seqBig !== expectedNextSeq) {
        this.fileSeqEndian = 'little';
      } else if (seqBig === expectedNextSeq && seqLittle !== expectedNextSeq) {
        this.fileSeqEndian = 'big';
      } else if (this.fileExpectedChunks > 0) {
        if (seqLittle < this.fileExpectedChunks && seqBig >= this.fileExpectedChunks) {
          this.fileSeqEndian = 'little';
        } else if (seqBig < this.fileExpectedChunks && seqLittle >= this.fileExpectedChunks) {
          this.fileSeqEndian = 'big';
        }
      }
    }

    return this.fileSeqEndian === 'big' ? seqBig : seqLittle;
  }

  private handleFileEofFrame(payload: Uint8Array) {
    if (!this.isFileTransferring) return;

    const eof = this.parseJsonPayload(payload);
    if (payload.byteLength > 0 && eof?.cmd !== 'EOF') {
      this.failFileTransfer('Invalid EOF packet metadata');
      return;
    }

    if (this.fileExpectedChunks > 0 && this.fileChunks.size !== this.fileExpectedChunks) {
      this.failFileTransfer(`Missing file chunks: received ${this.fileChunks.size}/${this.fileExpectedChunks}`);
      return;
    }

    const orderedChunks = Array.from(this.fileChunks.entries())
      .sort(([seqA], [seqB]) => seqA - seqB)
      .map(([, chunk]) => chunk);
    const totalLen = orderedChunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);

    if (totalLen !== this.fileTotalSize) {
      this.failFileTransfer(`NHRB file size mismatch: received ${totalLen}/${this.fileTotalSize}`);
      return;
    }

    const fullFile = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of orderedChunks) {
      fullFile.set(chunk, offset);
      offset += chunk.byteLength;
    }

    this.resetFileState();
    this.charFileData?.removeEventListener('characteristicvaluechanged', this.boundFileHandler);
    if (this.onFileTransfer) {
      this.onFileTransfer('complete', fullFile);
    }
  }

  private copyPayload(view: DataView, offset: number): Uint8Array {
    return new Uint8Array(view.buffer, view.byteOffset + offset, view.byteLength - offset).slice();
  }

  private parseJsonPayload(payload: Uint8Array): any | null {
    try {
      const jsonStr = new TextDecoder('utf-8').decode(payload);
      return JSON.parse(jsonStr);
    } catch (e) {
      return null;
    }
  }

  private failFileTransfer(message: string) {
    this.log(message, 'error');
    this.resetFileState();
    this.charFileData?.removeEventListener('characteristicvaluechanged', this.boundFileHandler);
    if (this.onFileTransfer) this.onFileTransfer('error', message);
  }

  private formatCharacteristicProperties(characteristic: BluetoothRemoteGATTCharacteristic | null): string {
    const props = characteristic?.properties;
    if (!props) return 'unknown';

    const enabled = [
      props.read ? 'read' : '',
      props.write ? 'write' : '',
      props.writeWithoutResponse ? 'writeWithoutResponse' : '',
      props.notify ? 'notify' : '',
      props.indicate ? 'indicate' : '',
    ].filter(Boolean);

    return enabled.length > 0 ? enabled.join(',') : 'none';
  }

  private async writeCharacteristicValue(
    characteristic: BluetoothRemoteGATTCharacteristic,
    data: Uint8Array,
  ): Promise<string> {
    const props = characteristic.properties;
    const canWriteWithResponse = props?.write !== false && typeof characteristic.writeValueWithResponse === 'function';
    const canWriteWithoutResponse = props?.writeWithoutResponse !== false && typeof characteristic.writeValueWithoutResponse === 'function';

    if (props?.write && typeof characteristic.writeValueWithResponse === 'function') {
      await characteristic.writeValueWithResponse(data);
      return 'writeWithResponse';
    }

    if (props?.writeWithoutResponse && !props.write && typeof characteristic.writeValueWithoutResponse === 'function') {
      await characteristic.writeValueWithoutResponse(data);
      return 'writeWithoutResponse';
    }

    if (canWriteWithResponse) {
      try {
        await characteristic.writeValueWithResponse!(data);
        return 'writeWithResponse';
      } catch (error) {
        if (!canWriteWithoutResponse) throw error;
      }
    }

    if (canWriteWithoutResponse) {
      await characteristic.writeValueWithoutResponse!(data);
      return 'writeWithoutResponse';
    }

    await characteristic.writeValue(data);
    return 'writeValue';
  }

  // --- Command Helpers ---

  async getDeviceInfo() { return this.sendCommand({ cmd: 'DI' }); }
  async getConfiguredDeviceName() { return this.sendCommand({ cmd: 'GDN' }); }
  async setConfiguredDeviceName(name: string) {
    assertValidBleDeviceName(name);
    // Passing an object to JSON.stringify in sendCommand preserves quotes,
    // backslashes, and other legal JSON characters without manual escaping.
    return this.sendCommand({ cmd: 'SDN', val: name });
  }
  async getInfo() { return this.sendCommand({ cmd: 'GRI' }); }
  async getPower() { return this.sendCommand({ cmd: 'GP' }); }
  async getProfile() { return this.sendCommand({ cmd: 'GLP' }); }
  async getQSession() { return this.sendCommand({ cmd: 'GQS' }); }
  async getBattery() { return this.sendCommand({ cmd: 'GB' }); }
  async getTemperature() { return this.sendCommand({ cmd: 'GT' }); }

  async getQueryParam() { return this.sendCommand({ cmd: 'GQP' }); }
  async getTagFocus() { return this.sendCommand({ cmd: 'GTF' }); }
  async getRegion() { return this.sendCommand({ cmd: 'GF' }); }

  async setPower(dbm: number) { return this.sendCommand({ cmd: 'SP', val: dbm }); }
  
  // Baseband: Profile, Q, Session, Target
  async setBaseband(profile: number, q: number, session: number, target = 0) {
    return this.sendCommand({ cmd: 'SRP', val: `${profile},${q},${session},${target}` });
  }

  // New specific setters based on firmware V12.0
  async setLinkProfile(profile: number) {
    return this.sendCommand({ cmd: 'SLP', val: profile });
  }

  async setQSession(q: number, session: number) {
    return this.sendCommand({ cmd: 'SQS', val: `${q},${session}` });
  }

  async setQueryParam(intervalMs: number, dwellRaw: number, append: number) {
    // V12.6: Send user-friendly values directly.
    // Firmware handles conversion to module raw format:
    //   interval: ms value (e.g. 50 = 50ms, firmware divides by 10 -> raw 5)
    //   dwell:    raw count (e.g. 150, module interprets as 150*100ms = 15s)
    //   append:   direct value (0-255)
    return this.sendCommand({ cmd: 'SQP', val: `${intervalMs},${dwellRaw},${append}` });
  }

  async setRegion(region: string, save = true) {
    return this.sendCommand({ cmd: 'SF', val: region, save });
  }

  async setCustomRegion(startKHz: number, count: number, space125KHz: number, save = true) {
    return this.sendCommand({
      cmd: 'SF',
      mode: 'custom',
      start_khz: startKHz,
      count,
      space_125khz: space125KHz,
      save,
    });
  }

  async setTagFocus(enable: boolean) { return this.sendCommand({ cmd: 'TF', val: enable ? 1 : 0 }); }
  async saveTagFocus(enable: boolean) { return this.sendCommand({ cmd: 'STF', val: enable ? 1 : 0 }); }
  
  async startScan() {
    this.clearPendingLiveTags();
    this.acceptLiveTags = true;
    try {
      await this.sendCommand({ cmd: 'S' });
    } catch (error) {
      this.suspendLiveTags();
      throw error;
    }
  }

  async stopScan() {
    this.suspendLiveTags();
    return this.sendCommand({ cmd: 'X' });
  }
  
  async startBatch() {
    this.suspendLiveTags();
    return this.sendCommand({ cmd: 'SB' });
  }
  async stopBatch() {
    this.suspendLiveTags();
    return this.sendCommand({ cmd: 'XB' });
  }

  // Deprecated: SMASK is removed in V12.1+
  // async setMask(epc: string) { return this.sendCommand({ cmd: 'SMASK', epc }); }
  // async clearMask() { return this.sendCommand({ cmd: 'SMASK', epc: '' }); }
  
  async locateTag(epc: string) { return this.sendCommand({ cmd: 'F', val: epc }); }

  async showPopup(content: string, time: number, beep: boolean) {
    const safeContent = content.substring(0, 15);
    return this.sendCommand({ cmd: 'POPUP', content: safeContent, time, beep });
  }

  async writeEpc(targetEpc: string, newEpc: string, password = "00000000") { 
    return this.sendCommand({ cmd: 'WE', epc: targetEpc, new: newEpc, pwd: password }); 
  }
  
  async writeData(epc: string, mem: number, ptr: number, data: string, password = "00000000") {
    return this.sendCommand({ cmd: 'WD', epc, mem, ptr, data, pwd: password });
  }

  async saveConfig() { return this.sendCommand({ cmd: 'SAVE' }); }

  // Queue commands to ensure they are serialized
  async sendCommand(command: object): Promise<void> {
    if (!this.charCmd) throw new Error('Not connected');
    if (this.intentionalUnpair) return;
    
    const str = JSON.stringify(command);
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const queueGeneration = this.commandQueueGeneration;

    // Append to queue. Recover from previous write failures so reconnects are not poisoned.
    this.commandQueue = this.commandQueue.catch(() => undefined).then(async () => {
      try {
        if (queueGeneration !== this.commandQueueGeneration || this.intentionalUnpair) return;
        if (this.charCmd) {
          const elapsedSinceLastWrite = Date.now() - this.lastCommandWriteAt;
          if (elapsedSinceLastWrite < COMMAND_WRITE_GAP_MS) {
            await wait(COMMAND_WRITE_GAP_MS - elapsedSinceLastWrite);
          }

          if (queueGeneration !== this.commandQueueGeneration || this.intentionalUnpair) return;

          const mode = await this.writeCharacteristicValue(this.charCmd, data);
          this.lastCommandWriteAt = Date.now();
          this.log(`TX (${mode}, ${data.byteLength}B): ${str}`, 'tx');
        }
      } catch (error: any) {
        this.log(`TX Failed: ${error.message}`, 'error');
        throw error;
      }
    });

    return this.commandQueue;
  }

  // Get Settings: Sends a sequence of commands to fetch device state
  async getSettings(): Promise<void> {
    // These will be queued automatically by sendCommand
    await this.sendCommand({ cmd: 'DI' });
    await this.sendCommand({ cmd: 'GDN' });
    await this.sendCommand({ cmd: 'GRI' });
    await this.sendCommand({ cmd: 'GB' });
    await this.sendCommand({ cmd: 'GT' });
    await this.sendCommand({ cmd: 'GP' });
    await this.sendCommand({ cmd: 'GLP' });
    await this.sendCommand({ cmd: 'GQS' });
    await this.sendCommand({ cmd: 'GQP' });
    await this.sendCommand({ cmd: 'GTF' });
    await this.sendCommand({ cmd: 'GF' });
  }
  
  async requestFileTransfer(): Promise<void> {
    if (!this.device || !this.device.gatt?.connected) {
        throw new Error('Device not connected');
    }
    
    if (this.isFileTransferring) {
        this.log('File transfer already in progress', 'error');
        return;
    }

    try {
        const operationGeneration = this.commandQueueGeneration;
        this.log('Requesting batch file...', 'info');
        this.resetFileState();
        this.isFileTransferring = true;
        
        // Step 1: Get characteristic and start notifications
        if (!this.charFileData) throw new Error('File Data Characteristic not found');
        
        await this.charFileData.startNotifications();
        if (this.intentionalUnpair || operationGeneration !== this.commandQueueGeneration) {
          this.resetFileState();
          return;
        }
        this.charFileData.addEventListener('characteristicvaluechanged', this.boundFileHandler);
        
        if (this.onFileTransfer) this.onFileTransfer('request');

        // Step 3: Write "send_file" to Control Characteristic
        if (!this.charFileReq) throw new Error('File Control Characteristic not found');
        if (this.intentionalUnpair || operationGeneration !== this.commandQueueGeneration) {
          this.resetFileState();
          this.charFileData.removeEventListener('characteristicvaluechanged', this.boundFileHandler);
          return;
        }
        
        const encoder = new TextEncoder();
        const command = encoder.encode('send_file');
        this.log('TX (FileReq): send_file', 'tx');
        await this.charFileReq.writeValue(command);
        
    } catch (error: any) {
        this.log(`Fetch History Failed: ${error.message}`, 'error');
        this.isFileTransferring = false;
        
        // Cleanup listener if failed
        if (this.charFileData) {
            this.charFileData.removeEventListener('characteristicvaluechanged', this.boundFileHandler);
        }
        
        if (this.onFileTransfer) this.onFileTransfer('error', error.message);
        throw error;
    }
  }
  
  private log(msg: string, type: 'info' | 'error' | 'rx' | 'tx') {
    if (this.onLog) this.onLog(msg, type);
    else console.log(`[${type.toUpperCase()}] ${msg}`);
  }
}

export const bleService = new BLEService();

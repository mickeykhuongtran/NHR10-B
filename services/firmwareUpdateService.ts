import { bleService, OtaBleSession } from './bleService';
import { OtaBleTransport } from './otaBleTransport';
import { assertCompatible, OtaPackage } from './otaPackage';
import { makeFrame, OTA_OP, OtaDeviceError, OtaEvent, OtaInfo, OtaStatus, OtaTransport, OtaTransportKind, otaSleep, withTimeout } from './otaProtocol';

export type UpdateStage = 'idle' | 'preparing' | 'review' | 'transferring' | 'verifying' | 'restarting' | 'confirmed' | 'failed' | 'cancelled';
export interface UpdateState {
  stage: UpdateStage; active: boolean; cancellable: boolean; percent: number; bytes: number; total: number;
  elapsed: number; remaining: number | null; message: string; info?: OtaInfo; target?: string; transport?: OtaTransportKind;
}
export const initialUpdateState: UpdateState = { stage: 'idle', active: false, cancellable: false, percent: 0, bytes: 0, total: 0, elapsed: 0, remaining: null, message: '' };
type Progress = (state: Partial<UpdateState>) => void;

/** Wire-state owner. Every DATA is sent once, followed by a durable ACK. */
export class FirmwareUpdater {
  private seq = crypto.getRandomValues(new Uint32Array(1))[0] % 0x7fffffff + 1;
  private cancelled = false;
  private finishing = false;
  private ownsSession = false;
  constructor(private transport: OtaTransport, private progress: Progress = () => {}, private event: OtaEvent = () => {}) {}
  cancel() { if (!this.finishing) this.cancelled = true; }
  private nextSequence() { this.seq = this.seq % 0xffffffff + 1; return this.seq; }
  private checkCancel() { if (this.cancelled && !this.finishing) throw new Error('Cancelled'); }
  private checkOwner(status: OtaStatus) {
    if ([1, 2, 3].includes(status.state) && status.source && status.source !== this.transport.source) {
      this.ownsSession = false; throw new OtaDeviceError(2);
    }
  }
  private async control(op: number, offset = 0, payload = new Uint8Array(), timeout = 10000) {
    const sequence = this.nextSequence(), frame = makeFrame(op, sequence, offset, payload);
    await this.transport.write(frame);
    const deadline = Date.now() + timeout; let retryAt = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (op !== OTA_OP.abort) this.checkCancel();
      const status = await this.transport.status(Math.min(10000, Math.max(1, deadline - Date.now())));
      this.checkOwner(status);
      if (status.seq === sequence) {
        if (status.error === 2) this.ownsSession = false;
        if (op === OTA_OP.abort && status.state === 4 && status.error === 13 && status.source === this.transport.source) return status;
        if (status.error) throw new OtaDeviceError(status.error);
        if (status.source !== this.transport.source) throw new Error('Invalid OTA acknowledgement owner.');
        if (op === OTA_OP.manifest) this.ownsSession = true;
        return status;
      }
      // Firmware BEGIN may spend 130 s saving active work. Do not flood its queue.
      if (op !== OTA_OP.begin && Date.now() >= retryAt) { await this.transport.write(frame); retryAt = Date.now() + 3000; }
      await otaSleep(10);
    }
    throw new Error('OTA control acknowledgement timed out. Reconnect and restart from the beginning.');
  }
  async run(pkg: OtaPackage, expected: OtaInfo, allowDowngrade = false): Promise<OtaInfo> {
    try {
      this.checkCancel();
      const info = await this.transport.info();
      if (info.id !== expected.id || info.fw !== expected.fw) throw new Error('Device identity or installed version changed after review. Prepare the update again.');
      assertCompatible(pkg, info, this.transport.kind, allowDowngrade);
      const status = await this.transport.status();
      if ([1, 2, 3].includes(status.state)) throw new OtaDeviceError(2);
      const chunk = info.max_frame - 12;
      this.progress({ stage: 'preparing', message: 'Preparing device', cancellable: true });
      for (let offset = 0; offset < pkg.manifest.length; offset += chunk) {
        this.checkCancel();
        const payload = pkg.manifest.slice(offset, offset + chunk);
        const ack = await this.control(OTA_OP.manifest, offset, payload);
        if (ack.state !== 1 || ack.offset !== offset + payload.length) throw new Error('Invalid manifest acknowledgement. Reconnect and restart.');
      }
      this.checkCancel();
      const begun = await this.control(OTA_OP.begin, 0, new Uint8Array(), 130000);
      if (begun.state !== 2 || begun.offset !== 0 || begun.total !== pkg.size) throw new Error('Invalid BEGIN acknowledgement. Reconnect and restart.');
      const started = Date.now(); let lastSample = -1, lastUiPercent = -1, lastUiAt = -Infinity;
      for (let offset = 0; offset < pkg.size;) {
        this.checkCancel();
        const data = pkg.image.slice(offset, offset + chunk), sequence = this.nextSequence();
        await this.transport.write(makeFrame(OTA_OP.data, sequence, offset, data));
        const ack = await this.transport.waitStatus(s => !!s.error || s.seq === sequence, 10000, () => this.cancelled);
        this.checkOwner(ack);
        if (ack.error) throw new OtaDeviceError(ack.error);
        offset += data.length;
        if (ack.seq !== sequence || ack.source !== this.transport.source || ack.state !== 2 || ack.offset !== offset || ack.total !== pkg.size)
          throw new Error('Invalid durable DATA acknowledgement. Reconnect and restart from the beginning.');
        const elapsed = Math.max((Date.now() - started) / 1000, 0.001), percent = Math.floor(offset * 100 / pkg.size);
        const remaining = offset ? (pkg.size - offset) / (offset / elapsed) : null;
        if (percent !== lastUiPercent || Date.now() - lastUiAt >= 200 || offset === pkg.size) {
          this.progress({ stage: 'transferring', message: 'Transferring firmware', percent, bytes: offset, total: pkg.size, elapsed, remaining });
          lastUiPercent = percent; lastUiAt = Date.now();
        }
        if (percent >= lastSample + 5 || offset === pkg.size) { this.event('progress', { bytes: offset, total: pkg.size, elapsed, percent }); lastSample = percent; }
      }
      this.checkCancel();
      // From this point even a lost FINISH reply may mean boot selection committed.
      this.finishing = true;
      this.progress({ stage: 'verifying', message: 'Verifying firmware', cancellable: false, percent: 100, remaining: null });
      let finishError: Error | undefined;
      try {
        const finish = await this.control(OTA_OP.finish);
        if (finish.state !== 3 || finish.offset !== pkg.size || finish.total !== pkg.size) throw new Error('Unexpected FINISH acknowledgement.');
      } catch (error) {
        finishError = error as Error;
        // Do not ABORT or enable Cancel after a possibly committed FINISH.
        this.event('finish-unconfirmed', { message: (error as Error).message });
      }
      this.progress({ stage: 'restarting', message: 'Restarting and checking firmware', cancellable: false });
      let running = await this.transport.reconnect();
      const deadline = Date.now() + 50000;
      for (;;) {
        this.event('post-boot-info', safeInfo(running));
        this.progress({ info: running });
        if (running.id !== expected.id) throw new Error('A different device reconnected. Update cannot be confirmed.');
        if (running.product !== 'NHR10-B' || running.hw !== 'REV-B' || running.project !== pkg.project || running.protocol !== 1)
          throw new Error('Post-update hardware or project identity does not match the reviewed reader. Update cannot be confirmed.');
        if (running.ready === true && running.pending === false) break;
        if (Date.now() >= deadline) throw new Error(`Startup confirmation timed out. Running version: ${running.fw}. Reconnect to check for rollback.`);
        await otaSleep(500);
        try { running = await this.transport.info(); } catch { running = await this.transport.reconnect(); }
      }
      if (running.fw !== pkg.version) throw new Error(`Update not confirmed. ${finishError ? finishError.message + ' ' : ''}Running version: ${running.fw}; target: ${pkg.version}. The reader may have rolled back.`);
      return running;
    } catch (error) {
      if (!this.finishing && this.ownsSession && !this.transport.disconnected) {
        try {
          const aborted = await this.control(OTA_OP.abort);
          if (aborted.state !== 4 || aborted.error !== 13) throw new Error('Abort not confirmed.');
          this.event('abort-confirmed');
        } catch { this.transport.disconnect(); }
      } else if (!this.finishing) this.transport.disconnect();
      throw error;
    }
  }
}

function safeInfo(info: OtaInfo): Record<string, unknown> {
  const { product, hw, id, fw, project, protocol, max_frame, ota, usb, profile, slot_size, slot, charge_only, ready, pending } = info;
  return { product, hw, id, fw, project, protocol, max_frame, ota, usb, profile, slot_size, slot, charge_only, ready, pending };
}
let activeOwner: FirmwareUpdateService | null = null;
interface Coordination { assertIdle(): void; pause(): void; resume(connected: boolean, info?: OtaInfo): void }

/** Holds the app mutex across preparation, explicit review, transfer and reboot. */
export class FirmwareUpdateService {
  state: UpdateState = { ...initialUpdateState };
  private listeners = new Set<() => void>();
  private trace: { time: string; event: string; detail?: Record<string, unknown> }[] = [];
  private session?: OtaBleSession;
  private transport?: OtaTransport;
  private runner?: FirmwareUpdater;
  private pkg?: OtaPackage;
  private reviewedInfo?: OtaInfo;
  private allowDowngrade = false;
  private cancelRequested = false;
  private releasePromise?: Promise<void>;
  private coordination?: Coordination;
  private paused = false;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  reset() { if (!this.state.active) this.set({ ...initialUpdateState, info: undefined, target: undefined, transport: undefined }); }
  log: OtaEvent = (event, detail) => {
    this.trace.push({ time: new Date().toISOString(), event, detail });
    if (this.trace.length > 2000) this.trace.splice(0, this.trace.length - 2000);
  };
  private set = (next: Partial<UpdateState>) => {
    if (next.stage && next.stage !== this.state.stage) this.log('stage', { from: this.state.stage, to: next.stage });
    this.state = { ...this.state, ...next }; this.listeners.forEach(listener => listener());
  };
  async prepare(pkg: OtaPackage, kind: OtaTransportKind, allowDowngrade: boolean, coordination: Coordination) {
    if (activeOwner || this.state.active) return;
    try { coordination.assertIdle(); } catch (error) { this.set({ stage: 'failed', message: (error as Error).message }); return; }
    activeOwner = this; this.coordination = coordination; this.releasePromise = undefined; this.cancelRequested = false;
    this.paused = false;
    this.pkg = pkg; this.reviewedInfo = undefined; this.allowDowngrade = allowDowngrade; this.trace = [];
    this.log('attempt', { transport: kind, target: pkg.version, packageHash: pkg.packageHash, imageHash: pkg.imageHash, source: pkg.source });
    this.set({ ...initialUpdateState, info: undefined, stage: 'preparing', active: true, cancellable: true, total: pkg.size, target: pkg.version, transport: kind, message: 'Preparing device' });
    try {
      if (!window.isSecureContext) throw new Error('Firmware updates require HTTPS or localhost.');
      coordination.pause();
      this.paused = true;
      // REVB BEGIN owns the stop/save + RFID reservation transaction. Drain the
      // controller's physical GATT queue before opening the OTA service.
      this.session = await bleService.acquireOtaSession();
      if (this.cancelRequested) throw new Error('Cancelled');
      const transport = new OtaBleTransport(this.session, this.log);
      this.transport = transport;
      const info = await transport.open();
      if (this.cancelRequested) throw new Error('Cancelled');
      if (this.session.canonicalId && this.session.canonicalId !== info.id) throw new Error('Selected updater is not the reader connected to the controller. Select the same device.');
      assertCompatible(pkg, info, kind, allowDowngrade);
      const status = await this.transport.status();
      if ([1, 2, 3].includes(status.state)) throw new OtaDeviceError(2);
      this.reviewedInfo = info;
      this.log('installed-info', safeInfo(info));
      this.set({ stage: 'review', info, message: 'Review and confirm installation' });
    } catch (error) { await this.fail(error); }
  }
  async install() {
    if (this.state.stage !== 'review' || !this.transport || !this.pkg || !this.reviewedInfo || this.cancelRequested) return;
    this.runner = new FirmwareUpdater(this.transport, this.set, this.log);
    this.set({ stage: 'preparing', message: 'Preparing device' });
    try {
      const info = await this.runner.run(this.pkg, this.reviewedInfo, this.allowDowngrade);
      this.log('confirmed-info', safeInfo(info));
      // Recover the same physical reader before returning the link to RFID.
      if (this.session?.device && !this.session.device.gatt?.connected) {
        try { await withTimeout(this.session.getServer(), 10000, 'RFID reconnect timed out.', () => this.session?.device?.gatt?.disconnect()); } catch { this.log('rfid-reconnect-unavailable'); }
      }
      await this.release(true);
      this.set({ stage: 'confirmed', active: false, cancellable: false, info, message: `Firmware ${info.fw} installed and startup confirmed.` });
    } catch (error) { await this.fail(error); }
  }
  async cancel() {
    if (!this.state.active || !this.state.cancellable || this.cancelRequested) return;
    this.cancelRequested = true;
    this.set({ cancellable: false, message: 'Cancelling safely…' });
    if (this.runner) { this.runner.cancel(); return; }
    if (this.state.stage === 'review') {
      await this.release(true);
      this.set({ stage: 'cancelled', active: false, cancellable: false, message: 'Update cancelled before transfer. Existing firmware remains selected.' });
    }
    else { this.transport?.disconnect(); }
    // Preparation observes this flag before opening a transport / offering MANIFEST.
  }
  private async fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.log('failure', { message });
    await this.release(false);
    this.set({ stage: this.cancelRequested ? 'cancelled' : 'failed', active: false, cancellable: false,
      message: this.cancelRequested ? 'Update cancelled. Reconnect the reader before retrying; the existing firmware remains selected.' : message });
  }
  private async release(resume: boolean) {
    if (this.releasePromise) return this.releasePromise;
    this.releasePromise = (async () => {
      let connected = false;
      try { await this.transport?.close(); }
      catch (error) { this.log('close-error', { message: (error as Error).message }); resume = false; }
      finally {
        try {
          if (this.session) connected = await this.session.release(resume);
          else if (this.paused && !bleService.isUpdating()) bleService.disconnect();
        }
        finally {
          this.session = undefined; this.transport = undefined; this.runner = undefined;
          if (activeOwner === this) activeOwner = null;
          if (this.paused) this.coordination?.resume(connected, connected ? this.state.info : undefined);
          this.paused = false; this.log('released', { connected });
        }
      }
    })();
    return this.releasePromise;
  }
  diagnostics() { return { format: 'nhr10-ota-diagnostics', schema: 1, exportedAt: new Date().toISOString(), state: { ...this.state, info: this.state.info ? safeInfo(this.state.info) : undefined }, events: this.trace }; }
}

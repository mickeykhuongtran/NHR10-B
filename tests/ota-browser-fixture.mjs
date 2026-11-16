/** Browser-only simulated peripheral. Used by Playwright, never imported by the app. */
export function installBleFixture(options = {}) {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const info = { product: 'NHR10-B', hw: 'REV-B', id: 'NHR10-28848586593C', fw: '1.2.0-dev.0',
    project: 'gatt_server_demos', protocol: 1, max_frame: 182, stream_window: 1, ota: 'ble', usb: 'none',
    slot_size: 3145728, slot: 'app0', ready: true, pending: false, charge_only: false };
  const state = { info, writes: [], commands: [], collisions: 0, commandsDuringOta: [], otaOpen: false,
    connectCount: 0, requestCount: 0, imageHash: '', bytes: 0, finished: false, ...options };
  globalThis.__otaFixture = state;
  let status = { state: 0, error: 0, source: 0, seq: 0, offset: 0, total: 0 };
  let manifest = new Uint8Array(108), image, targetVersion, busy = false;
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
  const statusBytes = () => {
    const bytes = new Uint8Array(20), view = new DataView(bytes.buffer);
    bytes.set([78, 83, 1, status.state]); view.setUint16(4, status.error, true); bytes[6] = status.source;
    view.setUint32(8, status.seq, true); view.setUint32(12, status.offset, true); view.setUint32(16, status.total, true);
    return bytes;
  };
  const operation = async work => {
    if (busy) { state.collisions++; throw new DOMException('GATT operation already in progress', 'NetworkError'); }
    busy = true;
    try { return await work(); } finally { busy = false; }
  };
  class Characteristic extends EventTarget {
    constructor(write, read, ack = false) { super(); this.write = write; this.read = read; this.ack = ack; }
    properties = { write: true, notify: true, read: true };
    async writeValueWithResponse(data) { return operation(() => this.write(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength))); }
    async writeValue(data) { return this.writeValueWithResponse(data); }
    async readValue() { return operation(() => { const bytes = this.read(); return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }); }
    async startNotifications() { return operation(() => this); }
    async stopNotifications() { return operation(() => { if (this.ack) state.otaOpen = false; return this; }); }
    notify(bytes) { this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.dispatchEvent(new Event('characteristicvaluechanged')); }
    json(value) { this.notify(encoder.encode(JSON.stringify(value))); }
  }
  const insurance = () => ({ cmd: 'TI', on: state.insurance ? 1 : 0, s: state.insurance ? 'ready' : 'off', id: 0,
    a: state.insurance ? 1 : 0, e: '', n: 0, t: 0, b: 0, g: 0, r: 0, z: 0, dur: 3000 });
  const cmd = new Characteristic(async bytes => {
    const request = JSON.parse(decoder.decode(bytes)); state.commands.push(request.cmd);
    if (state.otaOpen) state.commandsDuringOta.push(request.cmd);
    const replies = {
      DI: { cmd: 'DI', val: 'NHR-10' }, GRI: { cmd: 'GRI', ver: 'reader-fixture', power: 20 },
      GB: { cmd: 'GB', ver: 2, voltage: 7900, state: 'NORMAL', load: 'idle', percent: 73.4, valid: true, charging: false, full: false, health: 0, age_ms: 100 },
      GT: { cmd: 'GT', val: 32 }, GTI: insurance(), GP: { cmd: 'GP', val: 20 },
      GLP: { cmd: 'GLP', val: 15, format: 2 }, GQS: { cmd: 'GQS', q: 4, session: 1 },
      GQP: { cmd: 'GQP', interval: 30, dwell: 2, times: 0 }, GTF: { cmd: 'GTF', val: 0 },
      GF: { cmd: 'GF', status: 'ok', val: 'US', mode: 'template', band: 2, min_ch: 0, max_ch: 49, start_khz: 902750, end_khz: 927250, count: 50, step_khz: 500 },
    };
    if (request.cmd === 'TI') { state.insurance = request.val === 1; cmd.json(insurance()); }
    else if (replies[request.cmd]) cmd.json(replies[request.cmd]);
    else cmd.json({ cmd: request.cmd, status: 'ok' });
  });
  const ack = new Characteristic(undefined, statusBytes, true);
  const control = new Characteristic(async frame => {
    if (frame[0] !== 78 || frame[1] !== 85 || frame[2] !== 1 || frame.length > info.max_frame) throw new Error('Invalid NU frame');
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const op = frame[3], seq = view.getUint32(4, true), offset = view.getUint32(8, true), data = frame.subarray(12);
    state.writes.push({ op, seq, offset, bytes: data.length }); status.seq = seq; status.source = 1; status.error = 0;
    if (op === 1) { manifest.set(data, offset); status.state = 1; status.offset = offset + data.length; }
    if (op === 2) {
      if (manifest[6] !== 2) throw new Error('Wrong hardware manifest');
      status.total = new DataView(manifest.buffer).getUint32(8, true); status.offset = 0;
      targetVersion = decoder.decode(manifest.subarray(44, 76)).split('\0')[0];
      if (state.lowPower) { status.state = 4; status.error = 8; }
      else { status.state = 2; image = new Uint8Array(status.total); }
    }
    if (op === 3) {
      if (offset !== status.offset || status.state !== 2) throw new Error('Out-of-order or duplicate DATA');
      image.set(data, offset); status.offset += data.length; state.bytes = status.offset;
      // Yield periodically so browser paints and user cancellation can run.
      if (state.writes.length % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (op === 4) {
      if (status.offset !== status.total) throw new Error('Incomplete image');
      state.imageHash = await hash(image);
      const offeredHash = [...manifest.subarray(12, 44)].map(v => v.toString(16).padStart(2, '0')).join('');
      if (state.imageHash !== offeredHash) throw new Error('Transferred SHA-256 mismatch');
      state.finished = true; status.state = 3;
      if (!state.rollback) info.fw = targetVersion;
      info.pending = true; info.ready = false; info.slot = 'app1';
      setTimeout(() => { info.pending = false; info.ready = true; }, 400);
      setTimeout(() => device.gatt.disconnect(), 30);
      if (state.loseFinishReply) throw new DOMException('FINISH reply lost after commit', 'NetworkError');
    }
    if (op === 5) { status.state = 4; status.error = 13; }
    if (!(op === 3 && state.holdDataAck)) ack.notify(statusBytes());
  });
  const service = { getCharacteristic: async uuid => {
    const prefix = String(uuid).slice(0, 8);
    const chars = { '0000ff01': cmd, '0000ff02': new Characteristic(() => {}), '0000ff03': new Characteristic(() => {}),
      '4e485201': control, '4e485202': new Characteristic(undefined, () => {
        const bytes = statusBytes();
        if (state.holdDataAck && status.state === 2 && status.offset > 0) new DataView(bytes.buffer).setUint32(8, 0, true);
        return bytes;
      }), '4e485203': new Characteristic(undefined, () => encoder.encode(JSON.stringify(info))), '4e485205': ack };
    if (!chars[prefix]) throw new DOMException('Missing characteristic', 'NotFoundError');
    return chars[prefix];
  } };
  const device = Object.assign(new EventTarget(), { id: 'browser-fixture-revb', name: 'NHR-10' });
  device.gatt = {
    connected: false,
    async connect() { state.connectCount++; this.connected = true; return this; },
    disconnect() { if (this.connected) { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); } },
    getPrimaryService: async uuid => {
      if (String(uuid).startsWith('4e485200')) {
        if (state.legacyFirmware) throw new DOMException('No OTA service', 'NotFoundError');
        state.otaOpen = true;
      }
      return service;
    },
  };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: {
    requestDevice: async args => {
      state.requestCount++;
      if (!args.optionalServices?.includes('4e485200-10c0-4a01-8a01-000000000001')) throw new Error('OTA permission omitted');
      return device;
    },
  } });
}

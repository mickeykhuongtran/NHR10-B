import type { BatteryProtectionState, BatterySnapshot } from '../types';

export const BATTERY_POLL_INTERVAL_MS = 5000;
export const BATTERY_STALE_MS = 15000;
const ADC_VALID_AGE_MS = 3000;
const NO_ADC_SAMPLE = 0xffffffff;

const inRange = (value: unknown, min: number, max: number): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
);
const integerInRange = (value: unknown, min: number, max: number): number | null => (
  inRange(value, min, max) && Number.isInteger(value) ? value : null
);

/** Invalid/missing v2 fields clear the previous estimate; other commands are ignored. */
export const parseBatterySnapshot = (
  data: unknown,
  receivedAtMs = performance.now(),
): BatterySnapshot | null => {
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  if (payload.cmd !== 'GB') return null;

  const v2 = payload.ver === 2;
  const legacy = payload.ver === undefined;
  const state = typeof payload.state === 'string' ? payload.state.trim().toLowerCase() : '';
  const protectionState: BatteryProtectionState = (
    state === 'normal' || state === 'warning' || state === 'critical' || state === 'shutdown'
  ) ? state : 'unknown';
  const health = v2 ? integerInRange(payload.health, 0, 255) : null;
  const ageMs = v2 ? integerInRange(payload.age_ms, 0, NO_ADC_SAMPLE) : null;
  const shutdown = (v2 || legacy) && protectionState === 'shutdown';
  const valid = v2 && payload.valid === true && inRange(payload.percent, 0, 100) &&
    ageMs !== null && health !== null &&
    (shutdown || (ageMs <= ADC_VALID_AGE_MS && !(health & 4)));

  return {
    protocolVersion: integerInRange(payload.ver, 0, Number.MAX_SAFE_INTEGER),
    legacy,
    supported: v2 || legacy,
    // Preserve boot-time 0 and fault voltages as diagnostics only.
    voltageMv: integerInRange(payload.voltage, 0, 0xffffffff),
    protectionState,
    ...(payload.load === 'idle' || payload.load === 'load' ? { loadState: payload.load } : {}),
    percent: valid ? payload.percent as number : null,
    valid,
    charging: v2 && typeof payload.charging === 'boolean' ? payload.charging : null,
    full: valid && payload.full === true && payload.percent === 100 && health === 0 && !shutdown,
    health,
    ageMs,
    receivedAtMs,
    stale: false,
  };
};

export const isBatteryShutdown = (packet: BatterySnapshot): boolean => (
  packet.supported && packet.protectionState === 'shutdown'
);

export const isBatterySnapshotStale = (packet: BatterySnapshot, now = performance.now()): boolean => {
  if (isBatteryShutdown(packet)) return false;
  const elapsed = Math.max(0, now - packet.receivedAtMs);
  return packet.stale || elapsed >= BATTERY_STALE_MS ||
    (packet.ageMs !== null && packet.ageMs !== NO_ADC_SAMPLE && packet.ageMs + elapsed > BATTERY_STALE_MS);
};

export interface BatteryView {
  percent: number | null;
  text: string;
  fillPercent: number | null;
  status: string;
  tone: 'muted' | 'ready' | 'warning' | 'danger';
  charging: boolean | null;
  full: boolean;
  hint: string;
}

/** Shared display policy for the gauge, header and diagnostics. */
export const batteryView = (
  packet: BatterySnapshot | null,
  { connected = true, now = performance.now() }: { connected?: boolean; now?: number } = {},
): BatteryView => {
  const empty = (status: string, hint: string): BatteryView => ({
    percent: null, text: '—', fillPercent: null, status, tone: 'muted', charging: null, full: false, hint,
  });
  if (!connected) return empty('DISCONNECTED', 'Battery data unavailable while disconnected.');
  if (!packet) return empty('CHECKING', 'Waiting for battery data from the reader.');
  if (!packet.supported) return empty('UNSUPPORTED VERSION', 'This battery payload version is not supported.');
  if (isBatteryShutdown(packet)) {
    return { percent: 0, text: '0.0%', fillPercent: 0, status: 'SHUTDOWN', tone: 'danger',
      charging: null, full: false, hint: 'The reader has latched battery shutdown.' };
  }
  if (isBatterySnapshotStale(packet, now)) return empty('STALE', 'Battery data is stale; waiting for a new sample.');

  const percent = packet.percent;
  const health = packet.health;
  const charging = health === 0 && packet.ageMs !== null && packet.ageMs <= ADC_VALID_AGE_MS
    ? packet.charging : null;
  let status = 'NORMAL';
  let tone: BatteryView['tone'] = 'ready';
  if (packet.protectionState === 'critical') { status = 'CRITICAL'; tone = 'danger'; }
  else if (health !== null && (health & 1)) { status = 'HIGH VOLT'; tone = 'danger'; }
  else if (health !== null && (health & 2)) { status = 'CHG FAULT'; tone = 'danger'; }
  else if (health !== null && (health & 4)) { status = 'ADC CHECK'; tone = 'danger'; }
  else if (health) { status = 'BATTERY FAULT'; tone = 'danger'; }
  else if (packet.protectionState === 'warning') { status = 'WARNING'; tone = 'warning'; }
  else if (packet.legacy) { status = 'UPDATE FIRMWARE'; tone = 'muted'; }
  else if (percent === null) { status = 'CHECKING'; tone = 'muted'; }
  else if (packet.protectionState === 'unknown') { status = 'UNKNOWN STATE'; tone = 'muted'; }
  else if (packet.full) status = 'FULL';
  else if (charging === true) status = 'CHARGING';

  return {
    percent, text: percent === null ? '—' : `${percent.toFixed(1)}%`, fillPercent: percent,
    status, tone, charging: tone === 'danger' ? null : charging, full: status === 'FULL',
    hint: packet.legacy ? 'Update reader firmware to report battery percentage.'
      : percent === null ? 'The reader has no valid battery estimate.'
      : 'Battery percentage estimated by the reader.',
  };
};

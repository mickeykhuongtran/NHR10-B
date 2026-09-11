
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type ScanMode = 'interactive' | 'batch';

export type TagVisibility = 'active' | 'stale';

export interface ScanStats {
  visibleTags: number;
  totalReads: number;
  readsPerSecond: number;
  uniquePerSecond: number;
  averageRssi: number | null;
  peakRssi: number | null;
}

export interface Tag {
  epc: string;
  timestamp: number;
  firstSeen?: number;
  rssi?: number;
  count: number;
  antenna?: number;
  delta?: number;
  lastRssi?: number;
  lastSeen?: number;
  freshness?: number;
  visibility?: TagVisibility;
}

export interface SettingsSyncRevision {
  deviceName: number;
  power: number;
  linkProfile: number;
  qSession: number;
  queryParams: number;
  tagFocus: number;
  regionBand: number;
}

export type RegionBandPreset = 'US' | 'ETSI' | 'VN';
export type RegionBandSelection = RegionBandPreset;
export type RegionBandMode = 'template' | 'subset' | 'unknown';
export type RegionSupport = 'unknown' | 'supported' | 'unavailable';

export interface RegionBandConfig {
  val: string;
  mode: RegionBandMode;
  band: number;
  minCh: number;
  maxCh: number;
  startKHz?: number;
  endKHz?: number;
  count?: number;
  stepKHz?: number;
}

export interface RegionStatusUpdate {
  confirmed: boolean;
  support?: RegionSupport;
  error?: string | null;
  reading?: RegionBandConfig;
}

export type BatteryProtectionState = 'normal' | 'warning' | 'critical' | 'shutdown' | 'unknown';

export type BatteryLoadState = 'idle' | 'load';

/**
 * GB telemetry. Percent is the firmware estimate, never derived from voltage.
 * receivedAtMs uses performance.now(); ageMs is ADC age at notification receipt.
 */
export interface BatterySnapshot {
  protocolVersion: number | null;
  legacy: boolean;
  supported: boolean;
  voltageMv: number | null;
  protectionState: BatteryProtectionState;
  loadState?: BatteryLoadState;
  percent: number | null;
  valid: boolean;
  charging: boolean | null;
  full: boolean;
  health: number | null;
  ageMs: number | null;
  receivedAtMs: number;
  stale: boolean;
}

export interface Settings {
  power: number;
  buzzer: boolean;
  tagFocus: boolean;
  fastTid: boolean;
  linkProfile: number | null;
  linkProfileFormat?: 1 | 2 | null;
  /** True only after a valid response in the current connection. Not proof of persistence. */
  linkProfileConfirmed?: boolean;
  target?: number;
  qValue: number;
  session: number;
  scanParams: {
    interval: number;
    dwell: number;
    count: number;
    append?: number;
  };
  version: string;
  temperature: number;
  batterySnapshot: BatterySnapshot | null;
  /** Short, human-readable name shown in the UI (for example NHR10-8658A8). */
  deviceInfo: string;
  /** Current Bluetooth name returned by DI; read-only, cleared on disconnect. */
  deviceName: string;
  /** Full identity verified from the firmware DI response; never used as the primary label. */
  deviceCanonicalId: string;
  regionBand?: RegionBandConfig;
  regionBandConfirmed?: boolean;
  regionBandSupport?: RegionSupport;
  regionBandError?: string | null;
  syncRevision?: SettingsSyncRevision;
}

export interface LogEntry {
  type: 'info' | 'error' | 'rx' | 'tx';
  message: string;
  timestamp: number;
  notice?: { id: string; title: string };
}

export type WriteStatus = 'idle' | 'pending' | 'success' | 'error';
export type LocateSignalState = 'idle' | 'waiting' | 'detected' | 'lost';

export type ScanType = 'interactive' | 'batch' | null;

export type FileTransferStatus = 'idle' | 'requesting' | 'saving' | 'transferring' | 'parsing' | 'complete' | 'error';

export interface BatchHistoryRecord {
  INDEX: number;
  EPC: string;
}

export type BatchSaveState = 'idle' | 'saving' | 'saved' | 'save_failed';

export interface BatchSaveInfo {
  state: BatchSaveState;
  progress: number;
  written: number;
  total: number;
}

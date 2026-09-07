
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

export type RegionBandPreset = 'US' | 'ETSI' | 'VN' | 'JP' | 'KOR';
export type RegionBandSelection = RegionBandPreset | 'Custom';
export type RegionBandMode = 'template' | 'custom' | 'unknown';

export interface RegionBandConfig {
  val: string;
  mode: RegionBandMode;
  freband?: number;
  min?: number;
  max?: number;
  startKHz?: number;
  count?: number;
  space125KHz?: number;
  stepKHz?: number;
  save?: boolean;
}

export type BatteryProtectionState = 'normal' | 'warning' | 'critical' | 'shutdown';

export type BatteryLoadState = 'idle' | 'load';

export type BatteryChargePhase =
  | 'unknown'
  | 'not charging'
  | 'trickle'
  | 'precharge'
  | 'fast CC'
  | 'taper CV'
  | 'top-off'
  | 'terminated';

/**
 * Latest battery telemetry reported by the NHR-10 firmware.
 *
 * `visualPercent` is a voltage-zone gauge, not a measured state of charge.
 * The raw integer milli-unit values remain authoritative for diagnostics.
 */
export interface BatterySnapshot {
  voltageMv: number;
  protectionState: BatteryProtectionState;
  loadState?: BatteryLoadState;
  visualPercent: number;
  chargePhase?: BatteryChargePhase;
  vbusMv?: number;
  batteryCurrentMa?: number;
  pdVoltageMv?: number;
  pdCurrentMa?: number;
  chargerFaultMask?: number;
  receivedAtMs: number;
  stale: boolean;
}

export interface Settings {
  power: number;
  buzzer: boolean;
  tagFocus: boolean;
  fastTid: boolean;
  linkProfile: number;
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
  /** Exact UTF-8 GAP/advertising name returned by GDN. */
  deviceName: string;
  /** Full identity verified from the firmware DI response; never used as the primary label. */
  deviceCanonicalId: string;
  regionBand?: RegionBandConfig;
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

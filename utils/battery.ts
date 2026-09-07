import type {
  BatteryChargePhase,
  BatteryLoadState,
  BatteryProtectionState,
  BatterySnapshot,
} from '../types';

export const BATTERY_BOUNDS_MV = [6000, 7000, 7400, 7700, 8000, 8400] as const;

const MIN_PLAUSIBLE_PACK_MV = 4000;
const MAX_PLAUSIBLE_PACK_MV = 9000;

const PROTECTION_STATES = new Set<BatteryProtectionState>([
  'normal',
  'warning',
  'critical',
  'shutdown',
]);

const LOAD_STATES = new Set<BatteryLoadState>(['idle', 'load']);

const CHARGE_PHASES_BY_NORMALIZED_VALUE: Record<string, BatteryChargePhase> = {
  unknown: 'unknown',
  'not charging': 'not charging',
  trickle: 'trickle',
  precharge: 'precharge',
  'fast cc': 'fast CC',
  'taper cv': 'taper CV',
  'top-off': 'top-off',
  terminated: 'terminated',
};

const parseInteger = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
};

const normalizeProtectionState = (value: unknown): BatteryProtectionState | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase() as BatteryProtectionState;
  return PROTECTION_STATES.has(normalized) ? normalized : null;
};

const normalizeLoadState = (value: unknown): BatteryLoadState | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase() as BatteryLoadState;
  return LOAD_STATES.has(normalized) ? normalized : undefined;
};

const normalizeChargePhase = (value: unknown): BatteryChargePhase | undefined => {
  if (typeof value !== 'string') return undefined;
  return CHARGE_PHASES_BY_NORMALIZED_VALUE[value.trim().toLowerCase()];
};

export const batteryVisualPercent = (voltageMv: number): number => {
  if (!Number.isFinite(voltageMv) || voltageMv <= BATTERY_BOUNDS_MV[0]) return 0;
  if (voltageMv >= BATTERY_BOUNDS_MV[5]) return 100;

  let zone = 0;
  while (voltageMv >= BATTERY_BOUNDS_MV[zone + 1]) zone += 1;

  const lowerMv = BATTERY_BOUNDS_MV[zone];
  const upperMv = BATTERY_BOUNDS_MV[zone + 1];
  const fraction = (voltageMv - lowerMv) / (upperMv - lowerMv);
  return Math.round((zone + fraction) * 20);
};

export const isBatteryCharging = (phase: BatteryChargePhase | undefined): boolean => (
  phase === 'trickle' ||
  phase === 'precharge' ||
  phase === 'fast CC' ||
  phase === 'taper CV' ||
  phase === 'top-off'
);

/** Parse the current and compact GB formats into one application model. */
export const parseBatterySnapshot = (
  data: unknown,
  receivedAtMs = Date.now(),
): BatterySnapshot | null => {
  if (!data || typeof data !== 'object') return null;

  const payload = data as Record<string, unknown>;
  if (payload.cmd !== 'GB') return null;

  // `val` is accepted only as a legacy mV fallback. Percentage/volt values are
  // intentionally rejected so the current protocol cannot be misinterpreted.
  const voltageMv = parseInteger(payload.voltage ?? payload.val);
  const protectionState = normalizeProtectionState(payload.state);
  if (
    voltageMv === null ||
    voltageMv < MIN_PLAUSIBLE_PACK_MV ||
    voltageMv > MAX_PLAUSIBLE_PACK_MV ||
    protectionState === null
  ) {
    return null;
  }

  const loadState = normalizeLoadState(payload.load);
  const chargePhase = normalizeChargePhase(payload.chg);
  const vbusMv = parseInteger(payload.vbus);
  const batteryCurrentMa = parseInteger(payload.ibat);
  const pdVoltageMv = parseInteger(payload.pd_v);
  const pdCurrentMa = parseInteger(payload.pd_i);
  const chargerFaultMask = parseInteger(payload.fault);

  return {
    voltageMv,
    protectionState,
    visualPercent: batteryVisualPercent(voltageMv),
    ...(loadState !== undefined ? { loadState } : {}),
    ...(chargePhase !== undefined ? { chargePhase } : {}),
    ...(vbusMv !== null ? { vbusMv } : {}),
    ...(batteryCurrentMa !== null ? { batteryCurrentMa } : {}),
    ...(pdVoltageMv !== null ? { pdVoltageMv } : {}),
    ...(pdCurrentMa !== null ? { pdCurrentMa } : {}),
    ...(chargerFaultMask !== null ? { chargerFaultMask } : {}),
    receivedAtMs,
    stale: false,
  };
};

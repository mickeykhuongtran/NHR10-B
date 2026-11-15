export const insuranceStates = ['off', 'ready', 'preparing', 'running', 'ok', 'check', 'no_read', 'more', 'cancelled', 'error'] as const;
export type InsuranceState = typeof insuranceStates[number];
export const insuranceMinDuration = 1000;
export const insuranceMaxDuration = 30000;
export const insuranceWindowCount = (duration: number): number => Math.ceil(duration / 250);
export interface InsuranceConfig { min: number; bins: number; gap: number; dur: number }
export const defaultInsuranceConfig: InsuranceConfig = { min: 30, bins: 10, gap: 500, dur: 3000 };
export interface InsuranceSnapshot {
  enabled: boolean; busy: boolean; state: InsuranceState; id: number; attempt: number; epc: string;
  count: number; elapsed: number; bins: number; gap: number; reason: number; duration: number;
}
const validDuration = (ms: unknown): ms is number =>
  Number.isInteger(ms) && Number(ms) >= insuranceMinDuration && Number(ms) <= insuranceMaxDuration;
export const validInsuranceConfig = (c: InsuranceConfig): boolean =>
  validDuration(c.dur) &&
  Number.isInteger(c.min) && c.min >= 1 && c.min <= 10000 &&
  Number.isInteger(c.bins) && c.bins >= 1 && c.bins <= insuranceWindowCount(c.dur) &&
  Number.isInteger(c.gap) && c.gap >= 100 && c.gap <= c.dur;
export function parseInsuranceConfig(data: Record<string, unknown>): InsuranceConfig | null {
  // Missing dur is the legacy 3-second contract, not configurable timing.
  const c = { min: data.min, bins: data.bins, gap: data.gap, dur: data.dur === undefined ? 3000 : data.dur } as InsuranceConfig;
  return data.cmd === 'TIC' && validInsuranceConfig(c) ? c : null;
}
export function parseInsuranceSnapshot(data: unknown): InsuranceSnapshot | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.cmd !== 'TI' || (d.on !== 0 && d.on !== 1) || (d.z !== 0 && d.z !== 1) ||
      !insuranceStates.includes(d.s as InsuranceState) || typeof d.e !== 'string' ||
      !/^(?:[0-9a-fA-F]{2}){0,16}$/.test(d.e)) return null;
  const duration = d.dur === undefined ? defaultInsuranceConfig.dur : d.dur;
  if (!validDuration(duration)) return null;
  const ranges: [string, number][] = [['id', 0xffffffff], ['a', 2], ['n', 0xffffffff], ['t', duration], ['b', insuranceWindowCount(duration)], ['g', duration], ['r', 6]];
  if (ranges.some(([key, max]) => !Number.isInteger(d[key]) || Number(d[key]) < 0 || Number(d[key]) > max)) return null;
  if ((d.on === 0) !== (d.s === 'off') || (d.on === 1 && d.a === 0)) return null;
  return { enabled: d.on === 1, busy: d.z === 1, state: d.s as InsuranceState, id: Number(d.id), attempt: Number(d.a),
    epc: d.e, count: Number(d.n), elapsed: Number(d.t), bins: Number(d.b), gap: Number(d.g), reason: Number(d.r), duration };
}
export const insuranceTitles: Record<InsuranceState, string> = {
  off: 'Normal scanning', ready: 'READY', preparing: 'CHECK RF', running: 'SCANNING', ok: 'TAG OK', check: 'TAG ERROR',
  no_read: 'NO TAG FOUND', more: 'CHECK TAG', cancelled: 'CANCELLED', error: 'TEST ERROR',
};
export function insuranceErrorReason(v: InsuranceSnapshot): string {
  if (v.state !== 'error') return '';
  const reasons: Record<number, string> = {
    0: 'Unspecified device error', 1: 'RF communication or setup error',
    2: 'Read data integrity error', 3: 'Unsupported or malformed EPC',
    4: 'Legacy firmware retry mismatch', 5: 'Battery cannot support RF',
    6: 'Previous RF settings recovery failed',
  };
  return reasons[v.reason] ?? 'Unknown device error';
}
export function insuranceInstruction(v: InsuranceSnapshot): string {
  if (v.state === 'preparing') return 'The reader is checking that your RF settings are unchanged. The configured measurement time starts after this check.';
  if (v.state === 'running') return 'Keep the product at the marked position. Tap the trigger again to cancel.';
  if (v.state === 'more') return 'More than one EPC detected. Adjust the reader direction or isolate one product, then tap the trigger again. This is not a tag quality verdict.';
  if (v.state === 'no_read') return `No tag was detected within ${v.duration} ms. Check the product position and RF setup. Each trigger press starts an independent test.`;
  if (v.state === 'check') return 'One tag was detected, but its reads did not meet all configured thresholds at this RF setup and position. Each trigger press starts an independent test.';
  if (v.state === 'error') return v.reason === 2
    ? 'The reader could not finalize the received data reliably. This is not a tag quality verdict, even if all three thresholds are met. Check the firmware and Diagnostics; lowering thresholds will not resolve this error.'
    : v.reason === 1 ? 'The reader did not confirm its RF setup or start/stop operation. Stop Tag Insurance, read the RF settings and try again.'
    : v.reason === 3 ? 'The reader reported an EPC that this firmware cannot validate. This is not a tag quality verdict.'
    : v.reason === 4 ? 'Older firmware rejected the EPC during a retry. Update to the independent-trial firmware.'
    : v.reason === 5 ? 'Battery cannot support this test. Charge the reader before retrying.'
    : v.reason === 6 ? 'Previous firmware settings could not be recovered. Stop Tag Insurance to retry recovery, or restart the device.'
    : 'The measurement is invalid. Check the reader/link and retry; this is not a tag quality verdict.';
  if (v.state === 'ok') return 'This tag passed the current test setup. Move it to the good area, then test the next product.';
  if (v.state === 'off') return 'Enable Tag Insurance, then use the physical trigger on the reader.';
  return `One trigger press runs a ${v.duration} ms test. A second press cancels. Keep only one tagged product in the test area.`;
}

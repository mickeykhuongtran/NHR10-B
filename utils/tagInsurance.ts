export const insuranceStates = ['off', 'ready', 'preparing', 'running', 'ok', 'check', 'no_read', 'more', 'cancelled', 'error'] as const;
export type InsuranceState = typeof insuranceStates[number];
export interface InsuranceConfig { min: number; bins: number; gap: number }
export const defaultInsuranceConfig: InsuranceConfig = { min: 30, bins: 10, gap: 500 };
export interface InsuranceSnapshot {
  enabled: boolean; busy: boolean; state: InsuranceState; id: number; attempt: number; epc: string;
  count: number; elapsed: number; bins: number; gap: number; reason: number;
}
export const validInsuranceConfig = (c: InsuranceConfig): boolean =>
  Number.isInteger(c.min) && c.min >= 1 && c.min <= 10000 &&
  Number.isInteger(c.bins) && c.bins >= 1 && c.bins <= 12 &&
  Number.isInteger(c.gap) && c.gap >= 100 && c.gap <= 3000;
export function parseInsuranceSnapshot(data: unknown): InsuranceSnapshot | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.cmd !== 'TI' || (d.on !== 0 && d.on !== 1) || (d.z !== 0 && d.z !== 1) ||
      !insuranceStates.includes(d.s as InsuranceState) || typeof d.e !== 'string' ||
      !/^(?:[0-9a-fA-F]{2}){0,16}$/.test(d.e)) return null;
  const ranges: [string, number][] = [['id', 0xffffffff], ['a', 2], ['n', 0xffffffff], ['t', 3000], ['b', 12], ['g', 3000], ['r', 6]];
  if (ranges.some(([key, max]) => !Number.isInteger(d[key]) || Number(d[key]) < 0 || Number(d[key]) > max)) return null;
  if ((d.on === 0) !== (d.s === 'off') || (d.on === 1 && d.a === 0)) return null;
  return { enabled: d.on === 1, busy: d.z === 1, state: d.s as InsuranceState, id: Number(d.id), attempt: Number(d.a),
    epc: d.e, count: Number(d.n), elapsed: Number(d.t), bins: Number(d.b), gap: Number(d.g), reason: Number(d.r) };
}
export const insuranceTitles: Record<InsuranceState, string> = {
  off: 'Normal scanning', ready: 'READY', preparing: 'CHECK RF', running: 'TESTING', ok: 'TAG-OK', check: 'CHECK TAG',
  no_read: 'NO READ', more: 'MORE TAG', cancelled: 'CANCELLED', error: 'TEST ERROR',
};
export function insuranceInstruction(v: InsuranceSnapshot): string {
  if (v.state === 'preparing') return 'The reader is verifying the RF preset. The 3-second measurement starts after this check.';
  if (v.state === 'running') return 'Keep the product at the marked position. Tap the trigger again to cancel.';
  if (v.state === 'more') return 'More than one EPC detected. Isolate one product, then tap the trigger again.';
  if (v.state === 'check' || v.state === 'no_read') return v.attempt === 1
    ? 'Retry once with the SAME product at the SAME marked position. Do not move the antenna closer.'
    : 'The second test did not pass. Replace the tag with a QC-approved tag and test the product again.';
  if (v.state === 'error') return v.reason === 4 ? 'A different EPC appeared during the retry. Return to the same product and retry.'
    : v.reason === 5 ? 'Battery cannot support this test. Charge the reader before retrying.'
    : v.reason === 6 ? 'RF settings could not be restored. Select Normal scanning to retry restoration, or restart the device.'
    : 'The measurement is invalid. Check the reader/link and retry; this is not a tag quality verdict.';
  if (v.state === 'ok') return 'This tag passed the current test setup. Move it to the good area, then test the next product.';
  if (v.state === 'off') return 'Enable Tag Insurance, then use the physical trigger on the reader.';
  return 'One trigger press runs a 3-second test. A second press cancels. Keep only one tagged product in the test area.';
}

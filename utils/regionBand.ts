import { RegionBandConfig, RegionBandPreset } from '../types';

// Product presets from the REVB integration contract. Never send UART fields.
export const REGION_PRESETS = {
  US: { label: 'US (902-928 MHz)', band: 2, minCh: 0, maxCh: 49, startKHz: 902750, endKHz: 927250, count: 50, stepKHz: 500 },
  ETSI: { label: 'ETSI (865-868 MHz)', band: 9, minCh: 0, maxCh: 3, startKHz: 865700, endKHz: 867500, count: 4, stepKHz: 600 },
  VN: { label: 'VN (918-923 MHz)', band: 27, minCh: 0, maxCh: 7, startKHz: 918750, endKHz: 922250, count: 8, stepKHz: 500 },
} as const;

export const isRegionPreset = (value: unknown): value is RegionBandPreset => typeof value === 'string' && Object.hasOwn(REGION_PRESETS, value);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Only a complete GF response can establish the current channel plan. */
export function parseRegionReading(data: any): RegionBandConfig | null {
  if (data.cmd !== 'GF' || data.status !== 'ok') return null;
  const { band, min_ch: minCh, max_ch: maxCh } = data;
  if (!integer(band, 0, 255) || !integer(minCh, 0, 255) || !integer(maxCh, minCh, 255)) return null;
  const preset = (Object.keys(REGION_PRESETS) as RegionBandPreset[]).find(key => REGION_PRESETS[key].band === band);
  // Unknown bands are valid readings. In particular band 4 is not ETSI/EU3.
  if (!preset) return { val: 'UNKNOWN', mode: 'unknown', band, minCh, maxCh };
  const plan = REGION_PRESETS[preset];
  const { start_khz: startKHz, end_khz: endKHz, step_khz: stepKHz, count } = data;
  if (maxCh > plan.maxCh || !integer(startKHz, 840000, 960000) || !integer(endKHz, startKHz, 960000)
    || !integer(stepKHz, 1, 10000) || !integer(count, 1, 256)
    || count !== maxCh - minCh + 1 || stepKHz !== plan.stepKHz
    || startKHz !== plan.startKHz + minCh * stepKHz || endKHz !== startKHz + (count - 1) * stepKHz) return null;
  const full = minCh === plan.minCh && maxCh === plan.maxCh;
  return { val: full ? preset : 'CUSTOM', mode: full ? 'template' : 'subset', band, minCh, maxCh, startKHz, endKHz, count, stepKHz };
}

export function prepareRegionApply(selection: unknown, save: unknown) {
  if (!isRegionPreset(selection)) throw new Error('Region must be US, ETSI or VN.');
  if (typeof save !== 'boolean') throw new Error('Region save must be a JSON boolean.');
  const { band, minCh, maxCh } = REGION_PRESETS[selection];
  return { command: { cmd: 'SF', val: selection, save }, expected: { val: selection, band, minCh, maxCh } };
}

export function isRegionApplyConfirmed(data: any, selection: RegionBandPreset, save: boolean): boolean {
  const plan = REGION_PRESETS[selection];
  return data.cmd === 'SF' && data.status === 'ok' && data.val === selection && data.band === plan.band
    && data.min_ch === plan.minCh && data.max_ch === plan.maxCh && data.verified === true && data.saved === save;
}

export const formatRegionMHz = (khz: number) => (khz / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
export function describeRegion(reading: RegionBandConfig): string {
  const raw = `band ${reading.band}, channels ${reading.minCh}–${reading.maxCh}`;
  if (reading.mode === 'unknown') return `UNKNOWN — ${raw}; channel frequencies not reported`;
  return `${reading.val} — ${raw}; ${reading.count} channels, centers ${formatRegionMHz(reading.startKHz!)}–${formatRegionMHz(reading.endKHz!)} MHz, step ${reading.stepKHz} kHz`;
}
export function regionChannelCenters(reading: Pick<RegionBandConfig, 'startKHz' | 'stepKHz' | 'count'>): string {
  if (reading.startKHz === undefined || reading.stepKHz === undefined || reading.count === undefined) return '';
  return Array.from({ length: reading.count }, (_, index) => formatRegionMHz(reading.startKHz! + index * reading.stepKHz!)).join(', ') + ' MHz';
}

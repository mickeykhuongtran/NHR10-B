export type LinkProfileFormat = 1 | 2 | null;
export type RfPreset = 'standard' | 'quick' | 'deep';

export const parseProfileId = (value: unknown): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return null;
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 && id <= 65535 ? id : null;
};

export const parseProfileFormat = (value: unknown): LinkProfileFormat => value === 1 || value === 2 ? value : null;

export function assertProfileId(value: unknown): asserts value is number {
  if (typeof value !== 'number' || parseProfileId(value) === null) throw new Error('RF profile must be an unsigned 16-bit integer (0–65535).');
}

// Product presets only; unknown module IDs are preserved separately.
export const profileOptions = (format: LinkProfileFormat) => format === null ? [] : [
  { value: format === 1 ? 53 : 15, label: 'STD — 640 kHz / Miller 4' },
  { value: 11, label: 'QUICK — 640 kHz / FM0' },
  { value: 13, label: 'DEEP — 160 kHz / Miller 8' },
];

export const presetProfileId = (mode: RfPreset, format: LinkProfileFormat): number => {
  if (format === null) throw new Error('RF profile format is unknown. Read the profile before applying a preset.');
  return mode === 'standard' ? (format === 1 ? 53 : 15) : mode === 'quick' ? 11 : 13;
};

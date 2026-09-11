// Captured shapes from the REVB integration note, independent of the UI tables.
export const REGION_REPLIES = {
  US: { cmd: 'GF', status: 'ok', val: 'US', mode: 'template', band: 2, min_ch: 0, max_ch: 49, start_khz: 902750, end_khz: 927250, count: 50, step_khz: 500 },
  ETSI: { cmd: 'GF', status: 'ok', val: 'ETSI', mode: 'template', band: 9, min_ch: 0, max_ch: 3, start_khz: 865700, end_khz: 867500, count: 4, step_khz: 600 },
  VN: { cmd: 'GF', status: 'ok', val: 'VN', mode: 'template', band: 27, min_ch: 0, max_ch: 7, start_khz: 918750, end_khz: 922250, count: 8, step_khz: 500 },
} as const;
export const SUBSET_REPLY = { cmd: 'GF', status: 'ok', val: 'CUSTOM', mode: 'subset', band: 27, min_ch: 2, max_ch: 5, start_khz: 919750, end_khz: 921250, count: 4, step_khz: 500 };
export const UNKNOWN_REPLY = { cmd: 'GF', status: 'ok', val: 'UNKNOWN', mode: 'unknown', band: 4, min_ch: 0, max_ch: 14 };

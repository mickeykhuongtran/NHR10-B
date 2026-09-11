import { expect, it } from 'vitest';
import { REGION_REPLIES, SUBSET_REPLY, UNKNOWN_REPLY } from './region-fixtures';
import { describeRegion, isRegionApplyConfirmed, parseRegionReading, prepareRegionApply, regionChannelCenters } from '../utils/regionBand';
import { isSettingsBusy, parseSettingReading, prepareSettingApply } from '../utils/settingsProtocol';

it.each(['US', 'ETSI', 'VN'] as const)('reads the complete %s channel plan and sends only the preset code and boolean save', key => {
  const packet = REGION_REPLIES[key];
  const reading = parseRegionReading(packet)!;
  expect(reading).toMatchObject({ val: key, mode: 'template', band: packet.band, minCh: packet.min_ch, maxCh: packet.max_ch, startKHz: packet.start_khz, endKHz: packet.end_khz, stepKHz: packet.step_khz, count: packet.count });
  for (const save of [true, false]) {
    expect(prepareSettingApply({ id: 'region-band', mode: 'apply', value: { selection: key, save } }).command).toEqual({ cmd: 'SF', val: key, save });
    expect(isRegionApplyConfirmed({ cmd: 'SF', status: 'ok', val: key, band: packet.band, min_ch: packet.min_ch, max_ch: packet.max_ch, saved: save, verified: true }, key, save)).toBe(true);
  }
});
it('uses the actual four ETSI centers and the eight VN centers', () => {
  expect(regionChannelCenters(parseRegionReading(REGION_REPLIES.ETSI)!)).toBe('865.7, 866.3, 866.9, 867.5 MHz');
  expect(regionChannelCenters(parseRegionReading(REGION_REPLIES.VN)!)).toBe('918.75, 919.25, 919.75, 920.25, 920.75, 921.25, 921.75, 922.25 MHz');
});
it('accepts a subset as read-only CUSTOM even if a response labels it as a full preset', () => {
  const reading = parseRegionReading({ ...SUBSET_REPLY, val: 'VN', mode: 'template' })!;
  expect(reading).toMatchObject({ val: 'CUSTOM', mode: 'subset', band: 27, minCh: 2, maxCh: 5, count: 4 });
  expect(regionChannelCenters(reading)).toBe('919.75, 920.25, 920.75, 921.25 MHz');
});
it.each([4, 18, 255])('preserves unknown band %i as a valid read without inventing frequencies or ETSI mapping', band => {
  const reading = parseRegionReading({ ...UNKNOWN_REPLY, band, val: 'ETSI', start_khz: 865700, step_khz: 200 })!;
  expect(reading).toEqual({ val: 'UNKNOWN', mode: 'unknown', band, minCh: 0, maxCh: 14 });
  expect(regionChannelCenters(reading)).toBe('');
  expect(describeRegion(reading)).toContain('frequencies not reported');
});
it.each([
  { band: undefined }, { band: '27' }, { min_ch: -1 }, { max_ch: 8 }, { min_ch: 4, max_ch: 3 },
  { count: 9 }, { start_khz: 918500 }, { end_khz: 923000 }, { step_khz: 500.5 },
  { step_khz: undefined, space_125khz: 4 }, { status: 'err' }, { status: undefined }, { cmd: 'GRI', freq: 'VN' }, { cmd: 'SF' },
])('rejects malformed/incomplete or non-GF readings: %j', overrides => {
  expect(parseRegionReading({ ...REGION_REPLIES.VN, ...overrides })).toBeNull();
});
it.each(['JP', 'KOR', 'Custom', 'CUSTOM', 'EU3', 'UNKNOWN', undefined, 27])('rejects writing unsupported preset %s', value => {
  expect(() => prepareRegionApply(value, true)).toThrow();
});
it.each([undefined, null, 0, 1, 'true', 'false'])('rejects non-boolean save %s', save => {
  expect(() => prepareRegionApply('VN', save)).toThrow('boolean');
});
it('does not reuse RF profile format for Region support or parsing', () => {
  for (const format of [1, 2, null, undefined]) expect(parseSettingReading('region-band', { ...REGION_REPLIES.VN, format })?.band).toBe(27);
});
it.each([
  { status: 'err' }, { verified: false }, { verified: undefined }, { verified: 1 }, { saved: false },
  { saved: undefined }, { saved: 'true' }, { val: 'US' }, { band: 2 }, { min_ch: 1 }, { max_ch: 6 },
])('rejects incomplete or mismatched SF saved confirmations: %j', overrides => {
  expect(isRegionApplyConfirmed({ cmd: 'SF', status: 'ok', val: 'VN', band: 27, min_ch: 0, max_ch: 7, saved: true, verified: true, ...overrides }, 'VN', true)).toBe(false);
});
it('recognizes the legacy msg busy response', () => {
  expect(isSettingsBusy({ cmd: 'SF', status: 'err', msg: 'busy' })).toBe(true);
});

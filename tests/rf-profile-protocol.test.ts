import { expect, it } from 'vitest';
import { parseSettingReading, prepareSettingApply } from '../utils/settingsProtocol';
import { parseProfileId, parseProfileFormat, presetProfileId, profileOptions } from '../utils/rfLinkProfile';

it.each([1, 2] as const)('maps only the three product presets for format %i', format => {
  expect(profileOptions(format).map(option => option.value)).toEqual([format === 1 ? 53 : 15, 11, 13]);
  expect(['standard', 'quick', 'deep'].map(mode => presetProfileId(mode as 'standard' | 'quick' | 'deep', format))).toEqual([format === 1 ? 53 : 15, 11, 13]);
});
it.each([0, 15, 53, 255, 256, 5185, 65535])('preserves unsigned 16-bit ID %i through reads and writes', id => {
  expect(parseSettingReading('profile', { val: id, format: 2 })).toEqual({ val: id, format: 2 });
  expect(prepareSettingApply({ id: 'profile', mode: 'apply', value: id }).command).toEqual({ cmd: 'SLP', val: id });
  expect(prepareSettingApply({ id: 'baseband', mode: 'apply', value: { profile: id, q: 6, session: 255, target: 0 } }).command).toEqual({ cmd: 'SRP', val: `${id},6,255,0` });
});
it.each([-1, 65536, 1.5, NaN, Infinity, null, undefined, true, '', 'bad', '15junk'])('rejects malformed profile %s without coercing it to a device ID', value => {
  expect(parseProfileId(value)).toBeNull();
  expect(parseSettingReading('profile', { val: value })).toBeNull();
  expect(() => prepareSettingApply({ id: 'profile', mode: 'apply', value: value as number })).toThrow();
});
it('does not infer format from the ID, including IDs 15 and 53', () => {
  for (const val of [11, 13, 15, 53, 5185]) expect(parseSettingReading('profile', { val })).toEqual({ val, format: null });
  for (const format of [undefined, null, 0, 3, '2']) expect(parseProfileFormat(format)).toBeNull();
  expect(profileOptions(null)).toEqual([]);
  expect(() => presetProfileId('standard', null)).toThrow('unknown');
});
it('decodes GRP as profile,Q,session,target, including Auto session', () => {
  expect(parseSettingReading('baseband', { cmd: 'GRP', val: '5185,6,255,0', format: 2 })).toEqual({ profile: 5185, q: 6, session: 255, target: 0, format: 2 });
  expect(parseSettingReading('q-session', { val: '6,255' })).toEqual({ q: 6, session: 255 });
  for (const val of ['5185,6,4,0', '65536,6,255,0', '5185,6,255', '5185,16,255,0']) expect(parseSettingReading('baseband', { val })).toBeNull();
});

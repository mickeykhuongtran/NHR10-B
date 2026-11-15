import { afterEach, expect, it, vi } from 'vitest';
import { bleService } from '../services/bleService';
import { prepareSettingApply } from '../utils/settingsProtocol';
import { responseTimeoutMs, isRfTransportFault, validateRevbWrite, validPopupContent } from '../utils/revbProtocol';

afterEach(() => vi.restoreAllMocks());

it('budgets full multi-exchange operations and a competing LCD transaction', () => {
  expect(responseTimeoutMs('GP')).toBe(11000);
  expect(responseTimeoutMs('GLP')).toBe(13000);
  expect(responseTimeoutMs('GRP')).toBe(15000);
  expect(responseTimeoutMs('SLP')).toBe(17000);
  expect(responseTimeoutMs('SRP')).toBe(19000);
  expect(responseTimeoutMs('SF')).toBe(15000);
});

it('distinguishes RFID transport faults from unrelated Bluetooth and batch errors', () => {
  expect(isRfTransportFault({ cmd: 'SRP', status: 'err', error: 'timeout' })).toBe(true);
  expect(isRfTransportFault({ cmd: 'WE', status: 'err', code: 'transport_desynchronized' })).toBe(true);
  expect(isRfTransportFault({ cmd: 'DI', status: 'err', error: 'timeout' })).toBe(false);
  expect(isRfTransportFault({ cmd: 'SAVE', mode: 'batch', error: 'timeout' })).toBe(false);
});

it.each([-1, 31, 25.5, NaN, Infinity])('rejects RF power %s before firmware can clamp it', value => {
  expect(() => prepareSettingApply({ id: 'power', mode: 'apply', value })).toThrow('0 to 30');
});
it.each([
  { interval: 5, dwell: 2, append: 0 }, { interval: 70, dwell: 2, append: 0 },
  { interval: 30, dwell: 1, append: 0 }, { interval: 30, dwell: 256, append: 0 },
  { interval: 30, dwell: 2, append: 6 },
])('rejects query parameters outside the firmware contract: %j', value => {
  expect(() => prepareSettingApply({ id: 'query-params', mode: 'apply', value })).toThrow();
});
it('preserves raw dwell 0 and supports append 5', () => {
  expect(prepareSettingApply({ id: 'query-params', mode: 'apply', value: { interval: 60, dwell: 0, append: 5 } }).command).toEqual({ cmd: 'SQP', val: '60,0,5' });
  expect(() => prepareSettingApply({ id: 'q-session', mode: 'apply', value: { q: 16, session: 1 } })).toThrow();
  expect(() => prepareSettingApply({ id: 'q-session', mode: 'apply', value: { q: 6, session: 4 } })).toThrow();
});

it('fits complete words into the firmware EPC/data JSON buffers', () => {
  const epc = 'ABCD'.repeat(15), data = '0123'.repeat(31);
  expect(() => validateRevbWrite(epc, data, 3, 255, '00000000')).not.toThrow();
  expect(() => validateRevbWrite('', epc, 1, 1, '00000000', true)).not.toThrow();
  expect(() => validateRevbWrite('ABCD'.repeat(16), data, 3, 0, '00000000')).toThrow('Target EPC');
  expect(() => validateRevbWrite(epc, 'ABCD'.repeat(32), 3, 0, '00000000')).toThrow('Data');
  expect(() => validateRevbWrite(epc, data, 3, 256, '00000000')).toThrow('pointer');
  expect(() => validateRevbWrite(epc, data, 2, 0, '00000000')).toThrow('TID');
});

it('never sends unsupported passwords, TID writes or global SAVE to GATT', async () => {
  const send = vi.spyOn(bleService, 'sendCommand').mockResolvedValue(undefined);
  await expect(bleService.writeEpc('', 'AABBCCDD', '12345678')).rejects.toThrow('00000000');
  await expect(bleService.writeData('AABBCCDD', 3, 0, '11223344', '12345678')).rejects.toThrow('00000000');
  await expect(bleService.writeData('AABBCCDD', 2, 0, '11223344')).rejects.toThrow('TID');
  await expect(bleService.saveConfig()).rejects.toThrow('no global configuration SAVE');
  await expect(bleService.locateTag('ABCD'.repeat(9))).rejects.toThrow('up to 32');
  expect(send).not.toHaveBeenCalled();
  await bleService.writeEpc('', 'AABBCCDD');
  expect(send).toHaveBeenLastCalledWith({ cmd: 'WE', epc: '', new: 'AABBCCDD', pwd: '00000000' });
});

it('validates popup UTF-8 bytes and the REVB JSON string parser limitations', async () => {
  const send = vi.spyOn(bleService, 'sendCommand').mockResolvedValue(undefined);
  expect(validPopupContent('é'.repeat(7))).toBe(true);
  expect(validPopupContent('é'.repeat(8))).toBe(false);
  for (const text of ['say "hello"', 'a\\b', 'line\nbreak', 'a'.repeat(16)]) {
    await expect(bleService.showPopup(text, 2000, true)).rejects.toThrow('15 UTF-8 bytes');
  }
  expect(send).not.toHaveBeenCalled();
  await bleService.showPopup('Xin chào', 2000, false);
  expect(send).toHaveBeenLastCalledWith({ cmd: 'POPUP', content: 'Xin chào', time: 2000, beep: false });
});

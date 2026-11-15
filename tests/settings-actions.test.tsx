import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSettingsActions, SETTINGS_ACK_TIMEOUT_MS, SETTINGS_READ_TIMEOUT_MS } from '../hooks/useSettingsActions';
import { SettingId, SettingsRequest } from '../utils/settingsProtocol';
import { responseTimeoutMs } from '../utils/revbProtocol';
import { ConnectionStatus } from '../types';

const ble = vi.hoisted(() => ({ sendCommand: vi.fn() }));
vi.mock('../services/bleService', () => ({ bleService: ble }));
let actions: ReturnType<typeof useSettingsActions>;
let root: Root;
const log = vi.fn();
function Harness({ status = 'connected' }: { status?: ConnectionStatus }) { actions = useSettingsActions(log, status); return null; }
const receive = async (data: object) => { await act(async () => { actions.handleDataReceived(data); }); };
const start = async (request: SettingsRequest) => { await act(async () => { void actions.run(request); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); ble.sendCommand.mockResolvedValue(undefined);
  root = createRoot(document.createElement('div')); act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it.each<[SettingId, object, string]>([
  ['power', { cmd: 'GP', val: 20 }, '20 dBm'],
  ['profile', { cmd: 'GLP', val: 53 }, 'profile 53'],
  ['q-session', { cmd: 'GQS', q: 4, session: 1 }, 'Q 4, session S1'],
  ['query-params', { cmd: 'GQP', interval: 30, dwell: 2, times: 0 }, 'interval 30 ms'],
  ['tag-focus', { cmd: 'GTF', val: 1 }, 'On'],
  ['device-name', { cmd: 'DI', val: 'NHR-10' }, 'NHR-10'],
  ['region-band', { cmd: 'GF', status: 'ok', val: 'US', band: 2, min_ch: 0, max_ch: 49, start_khz: 902750, end_khz: 927250, count: 50, step_khz: 500 }, 'US'],
])('waits for a valid %s response before notifying Read successful', async (id, response, value) => {
  await start({ id, mode: 'read' });
  expect(actions.activity?.phase).toBe('Reading'); expect(log).not.toHaveBeenCalled();
  await receive({ cmd: 'GB', val: 99 }); expect(log).not.toHaveBeenCalled();
  await receive(response);
  expect(actions.activity).toBeNull();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining(value), 'info', expect.objectContaining({ title: 'Read successful' }));
});
it('waits for TF acknowledgement and a matching GTF read-back, ignoring status-only values', async () => {
  await start({ id: 'tag-focus', mode: 'apply', value: true });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'TF', val: 1 });
  await receive({ cmd: 'TF', status: 'ok' });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GTF' });
  expect(actions.activity?.phase).toBe('Verifying'); expect(log).not.toHaveBeenCalled();
  await receive({ cmd: 'GTF', status: 'ok' }); expect(log).not.toHaveBeenCalled();
  await receive({ cmd: 'GTF', val: 1 });
  expect(log).toHaveBeenLastCalledWith('Tag Focus: On.', 'info', expect.objectContaining({ title: 'Applied and verified' }));
});
it('reports a rejected setting without a success toast or verification command', async () => {
  await start({ id: 'q-session', mode: 'apply', value: { q: 2, session: 0 } });
  await receive({ cmd: 'SQS', status: 'err', code: 0 });
  expect(ble.sendCommand).toHaveBeenCalledOnce();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('SQS: 0'), 'error', expect.objectContaining({ title: 'Apply not confirmed' }));
});
it('does not call an acknowledged apply successful when the read-back differs', async () => {
  await start({ id: 'power', mode: 'apply', value: 25 });
  await receive({ cmd: 'SP', status: 'ok' }); await receive({ cmd: 'GP', val: 20 });
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Reader reports 20 dBm'), 'error', expect.objectContaining({ title: 'Apply not confirmed' }));
});
it('does not treat a GLP read-back as persistence confirmation after an SLP timeout', async () => {
  await start({ id: 'profile', mode: 'apply', value: 11 });
  await advance(SETTINGS_ACK_TIMEOUT_MS);
  expect(ble.sendCommand.mock.calls.map(call => call[0].cmd)).toEqual(['SLP', 'GLP']);
  await receive({ cmd: 'GLP', val: 11, format: 2 });
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('SLP'), 'error', expect.objectContaining({ title: 'Apply not confirmed' }));
  expect(actions.activity).toBeNull();
});
it('handles GCFG errors while reading an extended setting', async () => {
  await start({ id: 'query-params', mode: 'read' });
  await receive({ cmd: 'GCFG', status: 'err', code: 16 });
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('GCFG: 16'), 'error', expect.objectContaining({ title: 'Read not confirmed' }));
});
it('times out an unsupported GF despite ongoing telemetry and does not revive on a late reply', async () => {
  await start({ id: 'region-band', mode: 'read' });
  await advance(4000); await receive({ cmd: 'GB', val: 50 }); await advance(SETTINGS_READ_TIMEOUT_MS - 4000);
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('GF'), 'error', expect.objectContaining({ title: 'Read not confirmed' }));
  await receive({ cmd: 'GF', val: 'US' }); expect(log).toHaveBeenCalledOnce(); expect(actions.activity).toBeNull();
});
it('rejects the unsupported global SAVE locally; batch SAVE remains unrelated', async () => {
  // @ts-expect-error Historical clients cannot save global REVB configuration.
  await start({ id: 'config', mode: 'save' });
  expect(ble.sendCommand).not.toHaveBeenCalled();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('no global configuration SAVE'), 'error', expect.objectContaining({ title: 'Apply not confirmed' }));
  const calls = log.mock.calls.length;
  await receive({ cmd: 'SAVE', mode: 'batch', state: 'saved', status: 'ok' });
  expect(log).toHaveBeenCalledTimes(calls);
});
it('rejects transport failures and disconnects without leaving controls pending', async () => {
  ble.sendCommand.mockRejectedValueOnce(new Error('GATT write failed'));
  await start({ id: 'power', mode: 'read' }); expect(actions.activity).toBeNull();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('GATT write failed'), 'error', expect.anything());
  await start({ id: 'profile', mode: 'read' });
  await act(async () => root.render(<Harness status="disconnected" />));
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Connection lost'), 'error', expect.anything());
  expect(actions.activity).toBeNull(); expect(vi.getTimerCount()).toBe(0);
});
it('allows one transaction at a time and gives repeated reads distinct notice identities', async () => {
  await start({ id: 'power', mode: 'read' }); await start({ id: 'tag-focus', mode: 'read' });
  expect(ble.sendCommand).toHaveBeenCalledOnce();
  await receive({ cmd: 'GP', val: 20 });
  await start({ id: 'power', mode: 'read' }); await receive({ cmd: 'GP', val: 20 });
  expect(log.mock.calls.map(call => call[2].id)).toEqual(['settings-1', 'settings-2']);
});
it('cancels a pending transaction and its timer on unmount', async () => {
  await start({ id: 'power', mode: 'read' }); await act(async () => root.render(null));
  expect(vi.getTimerCount()).toBe(0); expect(log).not.toHaveBeenCalled();
});

it.each([15, 11, 13, 53, 5185, 65535])('requires SLP saved ACK and matching read-back for ID %i', async val => {
  await start({ id: 'profile', mode: 'apply', value: val });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'SLP', val });
  await receive({ cmd: 'GLP', val, format: 2 });
  expect(ble.sendCommand).toHaveBeenCalledOnce(); expect(log).not.toHaveBeenCalled();
  await advance(3999); expect(actions.activity?.phase).toBe('Applying');
  await receive({ cmd: 'SLP', status: 'ok', val, format: 2, persisted: true });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GLP' });
  expect(log).not.toHaveBeenCalled();
  await receive({ cmd: 'GLP', val, format: 2 });
  expect(log).toHaveBeenLastCalledWith(`RF link profile: profile ${val}.`, 'info', expect.objectContaining({ title: 'Đã lưu' }));
});
it.each([
  { cmd: 'SLP', status: 'ok', val: 13 },
  { cmd: 'SLP', status: 'ok', val: 13, persisted: false },
  { cmd: 'SLP', status: 'ok', val: 13, persisted: 'true' },
  { cmd: 'SLP', status: 'ok', val: 15, persisted: true },
  { cmd: 'SLP', status: 'ok', persisted: true },
  { cmd: 'SLP', status: 'err', error: 'persist_failed' },
])('never reports saved for incomplete/mismatched/failed SLP: %j', async ack => {
  await start({ id: 'profile', mode: 'apply', value: 13 });
  await receive(ack);
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GLP' });
  expect(actions.isPending()).toBe(true);
  await start({ id: 'power', mode: 'apply', value: 20 });
  expect(ble.sendCommand).toHaveBeenCalledTimes(2);
  await receive({ cmd: 'GLP', val: 13, format: 2 });
  expect(log.mock.calls.every(call => call[1] === 'error')).toBe(true);
  if (ack.status === 'err') expect(log.mock.calls[0][0]).toContain('persist_failed');
  expect(actions.isPending()).toBe(false);
});
it('requires another recovery read before writing when the previous recovery timed out', async () => {
  await start({ id: 'profile', mode: 'apply', value: 13 });
  await receive({ cmd: 'SLP', status: 'err', error: 'persist_failed' });
  await advance(responseTimeoutMs('GLP'));
  await start({ id: 'power', mode: 'apply', value: 20 });
  expect(ble.sendCommand.mock.calls.map(call => call[0].cmd)).toEqual(['SLP', 'GLP', 'GP']);
  await receive({ cmd: 'GP', val: 20 });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GLP' });
  await receive({ cmd: 'GLP', val: 13, format: 2 });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'SP', val: 20 });
});
it('rejects busy without repeating a SET or treating another caller completion as ours', async () => {
  await start({ id: 'profile', mode: 'apply', value: 13 });
  await receive({ cmd: 'SLP', status: 'err', error: 'busy' });
  expect(actions.isPending()).toBe(false);
  await receive({ cmd: 'SLP', status: 'ok', val: 13, persisted: true });
  await advance(30000);
  expect(ble.sendCommand).toHaveBeenCalledExactlyOnceWith({ cmd: 'SLP', val: 13 });
  expect(log.mock.calls.every(call => call[1] === 'error')).toBe(true);
  expect(log.mock.calls[0][0]).toContain('Stop the active RF');
});
it('fails a busy GET immediately and leaves retry to an explicit user action', async () => {
  await start({ id: 'profile', mode: 'read' });
  await receive({ cmd: 'GLP', status: 'busy' });
  expect(actions.isPending()).toBe(false);
  await advance(responseTimeoutMs('GLP') * 3);
  expect(ble.sendCommand).toHaveBeenCalledOnce();
  await start({ id: 'profile', mode: 'read' });
  expect(ble.sendCommand).toHaveBeenCalledTimes(2);
});
it('does not revive a rejected SLP when a matching LCD completion arrives later', async () => {
  await start({ id: 'profile', mode: 'apply', value: 13 });
  await receive({ cmd: 'SLP', status: 'busy' });
  const logged = log.mock.calls.length;
  await receive({ cmd: 'SLP', status: 'ok', val: 13, persisted: true });
  expect(ble.sendCommand).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledTimes(logged);
  expect(actions.activity).toBeNull();
});
it('stops a preset sequence and reads GRP after a partial SRP failure', async () => {
  await act(async () => { void actions.runSequence([
    { id: 'baseband', mode: 'apply', value: { profile: 15, q: 4, session: 1, target: 0 } },
    { id: 'tag-focus', mode: 'apply', value: true },
  ]); });
  await receive({ cmd: 'SRP', status: 'err', error: 'session_failed' });
  expect(ble.sendCommand.mock.calls.map(call => call[0].cmd)).toEqual(['SRP', 'GRP']);
  await receive({ cmd: 'GRP', val: '15,4,255,0', format: 2 });
  expect(ble.sendCommand).toHaveBeenCalledTimes(2); expect(actions.activity).toBeNull();
  expect(log.mock.calls.some(call => call[2]?.title === 'Đã lưu')).toBe(false);
});
it('cancels busy retries on disconnect', async () => {
  await start({ id: 'profile', mode: 'apply', value: 13 });
  await receive({ cmd: 'SLP', status: 'busy' });
  await act(async () => root.render(<Harness status="disconnected" />));
  await advance(15000);
  expect(ble.sendCommand).toHaveBeenCalledOnce(); expect(actions.isPending()).toBe(false);
});

it('does not retransmit when busy arrives near the compound ACK deadline', async () => {
  await start({ id: 'profile', mode: 'apply', value: 13 });
  await advance(SETTINGS_ACK_TIMEOUT_MS - 100);
  await receive({ cmd: 'SLP', status: 'busy' });
  expect(actions.isPending()).toBe(false);
  await advance(SETTINGS_ACK_TIMEOUT_MS * 2);
  expect(ble.sendCommand).toHaveBeenCalledOnce();
});
it('does not accept a value-only SLP as a saved acknowledgement', async () => {
  await start({ id: 'profile', mode: 'apply', value: 13 });
  await receive({ cmd: 'SLP', val: 13, format: 2, persisted: true });
  expect(log).not.toHaveBeenCalled();
  await advance(SETTINGS_ACK_TIMEOUT_MS);
  await receive({ cmd: 'GLP', val: 13, format: 2 });
  expect(log).toHaveBeenLastCalledWith(expect.any(String), 'error', expect.objectContaining({ title: 'Apply not confirmed' }));
});

it('reads Bluetooth name with DI and ignores legacy name replies and missing values', async () => {
  await start({ id: 'device-name', mode: 'read' });
  expect(ble.sendCommand).toHaveBeenCalledExactlyOnceWith({ cmd: 'DI' });
  for (const response of [
    { cmd: 'GDN', val: 'Old name' }, { cmd: 'SDN', status: 'ok', val: 'Old name' },
    { cmd: 'DI', status: 'ok' }, { cmd: 'DI', val: '' }, { cmd: 'DI', val: 123 },
  ]) {
    await receive(response);
    expect(actions.activity?.phase).toBe('Reading'); expect(log).not.toHaveBeenCalled();
  }
  await receive({ cmd: 'DI', val: 'NHR-10' });
  expect(ble.sendCommand).toHaveBeenCalledOnce();
  expect(log).toHaveBeenLastCalledWith('Bluetooth device name: NHR-10.', 'info', expect.objectContaining({ title: 'Read successful' }));
});

it.each(['error', 'timeout'])('does not report success when DI returns %s', async failure => {
  await start({ id: 'device-name', mode: 'read' });
  if (failure === 'error') await receive({ cmd: 'DI', status: 'err', error: 'unsupported_command', val: 'NHR-10' });
  else await advance(SETTINGS_READ_TIMEOUT_MS);
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('DI'), 'error', expect.objectContaining({ title: 'Read not confirmed' }));
  expect(actions.activity).toBeNull();
  expect(ble.sendCommand).toHaveBeenCalledOnce();
});

it('rejects a legacy name Apply request without sending a BLE command', async () => {
  // @ts-expect-error Bluetooth name is read-only, including for stale callers at runtime.
  await start({ id: 'device-name', mode: 'apply', value: 'NHR10-TEST' });
  expect(ble.sendCommand).not.toHaveBeenCalled();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('read-only'), 'error', expect.objectContaining({ title: 'Apply not confirmed' }));
});

it('accepts actual REVB SRP status-only completion only after fresh matching GRP', async () => {
  const value = { profile: 5185, q: 6, session: 255, target: 1 };
  await start({ id: 'baseband', mode: 'apply', value });
  await receive({ cmd: 'GLP', val: 5185, format: 2 }); // intermediate profile stage
  expect(ble.sendCommand).toHaveBeenCalledOnce(); expect(log).not.toHaveBeenCalled();
  await advance(8500); // More than the old 4 s ACK deadline.
  await receive({ cmd: 'SRP', status: 'ok' });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GRP' });
  expect(log).not.toHaveBeenCalled();
  await receive({ cmd: 'GRP', val: '5185,6,255,1', format: 2 });
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('profile 5185'), 'info', expect.objectContaining({ title: 'Applied and verified' }));
});

it('keeps SLP pending through the firmware negotiation and competing LCD budget', async () => {
  await start({ id: 'profile', mode: 'apply', value: 65535 });
  await advance(10500); expect(log).not.toHaveBeenCalled();
  await receive({ cmd: 'SLP', status: 'ok', val: 65535, format: 2, persisted: true });
  await receive({ cmd: 'GLP', val: 65535, format: 2 });
  expect(actions.activity).toBeNull();
  expect(log).toHaveBeenLastCalledWith(expect.any(String), 'info', expect.objectContaining({ title: 'Đã lưu' }));
});

it('saves Tag Focus with STF and verifies GTF without accepting a foreign TF ACK', async () => {
  await start({ id: 'tag-focus', mode: 'apply', value: true, persist: true });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'STF', val: 1 });
  await receive({ cmd: 'TF', status: 'ok' }); expect(ble.sendCommand).toHaveBeenCalledOnce();
  await receive({ cmd: 'STF', status: 'ok' });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GTF' });
  await receive({ cmd: 'GTF', val: 1 });
  expect(log).toHaveBeenLastCalledWith('Tag Focus: On.', 'info', expect.objectContaining({ title: 'Đã lưu' }));
});

it('requires a fresh UART GET after quarantine; DI and late SET ACKs cannot clear it', async () => {
  await receive({ cmd: 'SP', status: 'err', code: 'transport_desynchronized' });
  expect(actions.isRfRecoveryRequired()).toBe(true);
  await start({ id: 'device-name', mode: 'read' }); await receive({ cmd: 'DI', val: 'NHR-10' });
  expect(actions.isRfRecoveryRequired()).toBe(true);
  await start({ id: 'power', mode: 'apply', value: 20 });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GP' });
  await receive({ cmd: 'SP', status: 'ok', val: 20 });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GP' });
  await receive({ cmd: 'GP', status: 'err', error: 'transport_desynchronized' });
  expect(ble.sendCommand.mock.calls.map(call => call[0].cmd)).toEqual(['DI', 'GP']);
  await start({ id: 'power', mode: 'read' }); await receive({ cmd: 'GP', val: 20 });
  expect(actions.isRfRecoveryRequired()).toBe(false);
  await start({ id: 'power', mode: 'apply', value: 20 });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'SP', val: 20 });
});

it('does not fail a fresh GET on unrelated LCD SET errors', async () => {
  await start({ id: 'power', mode: 'read' });
  await receive({ cmd: 'SP', status: 'err', code: 254 });
  expect(actions.isPending()).toBe(true); expect(log).not.toHaveBeenCalled();
  await receive({ cmd: 'GP', val: 20 });
  expect(actions.isPending()).toBe(false);
});

it('ignores a stale GATT rejection after reconnect and a successful recovery read', async () => {
  let rejectOldWrite!: (error: Error) => void;
  ble.sendCommand.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOldWrite = reject; }));
  await start({ id: 'power', mode: 'read' });
  await act(async () => root.render(<Harness status="disconnected" />));
  await act(async () => root.render(<Harness status="connected" />));
  await start({ id: 'power', mode: 'read' });
  await receive({ cmd: 'GP', val: 20 });
  await act(async () => { rejectOldWrite(new Error('Old connection closed')); });
  expect(actions.isRfRecoveryRequired()).toBe(false);
  expect(actions.isPending()).toBe(false);
});

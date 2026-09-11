import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSettingsActions, SETTINGS_ACK_TIMEOUT_MS, SETTINGS_READ_TIMEOUT_MS } from '../hooks/useSettingsActions';
import { SettingId, SettingsRequest } from '../utils/settingsProtocol';
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
  ['device-name', { cmd: 'GDN', val: 'NHR10-DEMO' }, 'NHR10-DEMO'],
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
  await advance(4000); await receive({ cmd: 'GB', val: 50 }); await advance(1000);
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('GF'), 'error', expect.objectContaining({ title: 'Read not confirmed' }));
  await receive({ cmd: 'GF', val: 'US' }); expect(log).toHaveBeenCalledOnce(); expect(actions.activity).toBeNull();
});
it('does not confuse batch SAVE notifications with configuration-save acknowledgements', async () => {
  await start({ id: 'config', mode: 'save' });
  await receive({ cmd: 'SAVE', mode: 'batch', state: 'saved', status: 'ok' }); expect(log).not.toHaveBeenCalled();
  await advance(SETTINGS_READ_TIMEOUT_MS);
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('SAVE'), 'error', expect.objectContaining({ title: 'Save not confirmed' }));
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
  await advance(SETTINGS_READ_TIMEOUT_MS);
  await start({ id: 'power', mode: 'apply', value: 20 });
  expect(ble.sendCommand.mock.calls.map(call => call[0].cmd)).toEqual(['SLP', 'GLP', 'GLP']);
  await receive({ cmd: 'GLP', val: 13, format: 2 });
  expect(ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'SP', val: 20 });
});
it('waits for the previous configuration operation to finish before retrying busy', async () => {
  await start({ id: 'profile', mode: 'apply', value: 13 });
  await receive({ cmd: 'SLP', status: 'err', error: 'busy' });
  await start({ id: 'power', mode: 'apply', value: 20 });
  await receive({ cmd: 'GB', status: 'ok', val: 90 });
  await advance(2000);
  expect(ble.sendCommand).toHaveBeenCalledOnce(); expect(actions.activity?.phase).toBe('Waiting');
  await receive({ cmd: 'SQS', status: 'ok' });
  expect(ble.sendCommand.mock.calls.map(call => call[0].cmd)).toEqual(['SLP', 'SLP']);
  expect(log).not.toHaveBeenCalled();
  await receive({ cmd: 'SLP', status: 'ok', val: 13, persisted: true, format: 2 });
  await receive({ cmd: 'GLP', val: 13, format: 2 });
  expect(log).toHaveBeenLastCalledWith(expect.any(String), 'info', expect.objectContaining({ title: 'Đã lưu' }));
});
it('bounds busy retries and waits a full operation window without a completion event', async () => {
  await start({ id: 'profile', mode: 'read' });
  for (let i = 0; i < 3; i++) {
    expect(ble.sendCommand).toHaveBeenCalledTimes(i + 1);
    await receive({ cmd: 'GLP', status: 'busy' });
    await advance(SETTINGS_READ_TIMEOUT_MS - 1);
    expect(ble.sendCommand).toHaveBeenCalledTimes(i + 1);
    await advance(1);
  }
  expect(ble.sendCommand).toHaveBeenCalledTimes(3);
  expect(actions.isPending()).toBe(false);
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('busy'), 'error', expect.anything());
});
it('does not mistake the previous SLP completion for the new request after busy', async () => {
  await start({ id: 'profile', mode: 'apply', value: 13 });
  await receive({ cmd: 'SLP', status: 'busy' });
  await receive({ cmd: 'SLP', status: 'ok', val: 13, persisted: true });
  expect(ble.sendCommand.mock.calls.map(call => call[0].cmd)).toEqual(['SLP', 'SLP']);
  expect(log).not.toHaveBeenCalled();
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

it('waits a full busy window even when the busy response arrives near the ACK deadline', async () => {
  await start({ id: 'profile', mode: 'apply', value: 13 });
  await advance(SETTINGS_ACK_TIMEOUT_MS - 100);
  await receive({ cmd: 'SLP', status: 'busy' });
  await advance(SETTINGS_ACK_TIMEOUT_MS - 1);
  expect(ble.sendCommand).toHaveBeenCalledOnce();
  await advance(1);
  expect(ble.sendCommand).toHaveBeenCalledTimes(2);
});
it('does not accept a value-only SLP as a saved acknowledgement', async () => {
  await start({ id: 'profile', mode: 'apply', value: 13 });
  await receive({ cmd: 'SLP', val: 13, format: 2, persisted: true });
  expect(log).not.toHaveBeenCalled();
  await advance(SETTINGS_ACK_TIMEOUT_MS);
  await receive({ cmd: 'GLP', val: 13, format: 2 });
  expect(log).toHaveBeenLastCalledWith(expect.any(String), 'error', expect.objectContaining({ title: 'Apply not confirmed' }));
});

it('consumes a late legacy SDN ACK without scheduling a second GET or finishing verification', async () => {
  await start({ id: 'device-name', mode: 'apply', value: 'NHR10-TEST' });
  await advance(SETTINGS_ACK_TIMEOUT_MS);
  expect(ble.sendCommand.mock.calls.map(call => call[0].cmd)).toEqual(['SDN', 'GDN']);
  let handled = false;
  await act(async () => { handled = actions.handleDataReceived({ cmd: 'SDN', status: 'ok', val: 'NHR10-TEST' }); });
  expect(handled).toBe(true); expect(actions.activity?.phase).toBe('Verifying');
  await receive({ cmd: 'GDN', val: 'NHR10-TEST' });
  expect(log).toHaveBeenLastCalledWith(expect.any(String), 'info', expect.objectContaining({ title: 'Applied and verified' }));
});

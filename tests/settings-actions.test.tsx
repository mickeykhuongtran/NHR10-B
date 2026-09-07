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
  ['region-band', { cmd: 'GF', mode: 'template', val: 'US' }, 'US'],
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
it('verifies legacy SLP via GLP even when the firmware emits no SET success acknowledgement', async () => {
  await start({ id: 'profile', mode: 'apply', value: 11 });
  await advance(SETTINGS_ACK_TIMEOUT_MS);
  expect(ble.sendCommand.mock.calls.map(call => call[0].cmd)).toEqual(['SLP', 'GLP']);
  expect(log).not.toHaveBeenCalled();
  await receive({ cmd: 'GLP', val: 11 });
  expect(log).toHaveBeenLastCalledWith('RF link profile: profile 11.', 'info', expect.objectContaining({ title: 'Applied and verified' }));
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

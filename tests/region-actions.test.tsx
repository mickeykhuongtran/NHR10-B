import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSettingsActions } from '../hooks/useSettingsActions';
import { useRFIDConnection } from '../hooks/useRFIDConnection';
import { ConnectionStatus, RegionBandPreset } from '../types';
import { SettingsRequest } from '../utils/settingsProtocol';
import { REGION_REPLIES, SUBSET_REPLY, UNKNOWN_REPLY } from './region-fixtures';

vi.mock('../services/bleService', () => ({ bleService: {} }));
const send = vi.fn(), log = vi.fn();
let root: Root, actions: ReturnType<typeof useSettingsActions>, connection: ReturnType<typeof useRFIDConnection>;
function Harness({ status = 'connected' }: { status?: ConnectionStatus }) {
  connection = useRFIDConnection();
  actions = useSettingsActions(log, status, send, connection.invalidateProfile, connection.updateRegionStatus);
  return null;
}
const start = async (request: SettingsRequest) => { await act(async () => { void actions.run(request); }); };
const receive = async (packet: object) => { await act(async () => { actions.handleDataReceived(packet); connection.handleDataReceived(packet); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const read = async (packet: object = REGION_REPLIES.US) => { await start({ id: 'region-band', mode: 'read' }); await receive(packet); };
const apply = (selection: RegionBandPreset = 'VN', save = true) => start({ id: 'region-band', mode: 'apply', value: { selection, save } });
const ack = (selection: RegionBandPreset = 'VN', saved = true) => ({ cmd: 'SF', status: 'ok', val: selection, band: REGION_REPLIES[selection].band, min_ch: 0, max_ch: REGION_REPLIES[selection].max_ch, saved, verified: true });
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); send.mockResolvedValue(undefined);
  root = createRoot(document.createElement('div')); act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it('blocks Region writes before a valid GF, regardless of RF profile format', async () => {
  await receive({ cmd: 'GLP', val: 15, format: 2 });
  await apply();
  expect(send).not.toHaveBeenCalled();
  expect(connection.settings.regionBandConfirmed).toBe(false);
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Read Region successfully'), 'error', expect.anything());
});
it.each(['US', 'ETSI', 'VN'] as const)('confirms saved and temporary %s only after matching SF flags and a fresh GF', async selection => {
  await read();
  for (const save of [true, false]) {
    log.mockClear();
    await apply(selection, save);
    expect(send).toHaveBeenLastCalledWith({ cmd: 'SF', val: selection, save });
    expect(connection.settings.regionBandConfirmed).toBe(false); expect(log).not.toHaveBeenCalled();
    await receive(ack(selection, save));
    expect(send).toHaveBeenLastCalledWith({ cmd: 'GF' }); expect(log).not.toHaveBeenCalled();
    await receive(REGION_REPLIES[selection]);
    expect(connection.settings).toMatchObject({ regionBandConfirmed: true, regionBandSupport: 'supported', regionBand: { val: selection } });
    expect(log).toHaveBeenLastCalledWith(expect.any(String), 'info', expect.objectContaining({ title: save ? 'Đã lưu' : 'Đã áp dụng tạm thời' }));
  }
});
it.each([SUBSET_REPLY, UNKNOWN_REPLY])('accepts read-only non-preset state and permits an explicit supported replacement: %j', async packet => {
  await read(packet);
  expect(connection.settings).toMatchObject({ regionBandConfirmed: true, regionBandSupport: 'supported', regionBand: { band: packet.band, val: packet.val } });
  await apply('ETSI', false);
  expect(send).toHaveBeenLastCalledWith({ cmd: 'SF', val: 'ETSI', save: false });
});
it.each([
  { saved: false }, { saved: undefined }, { verified: false }, { verified: undefined },
  { val: 'US' }, { band: 9 }, { min_ch: 1 }, { max_ch: 6 }, { saved: 'true' },
])('never saves from an incomplete/mismatched ACK, recovers after cooldown: %j', async overrides => {
  await read(); log.mockClear(); await apply();
  await receive({ ...ack(), ...overrides });
  expect(connection.settings).toMatchObject({ regionBandConfirmed: false, regionBand: { val: 'US' } });
  expect(send.mock.calls.map(call => call[0].cmd)).toEqual(['GF', 'SF']);
  await advance(999); expect(send).toHaveBeenCalledTimes(2);
  await advance(1); expect(send).toHaveBeenLastCalledWith({ cmd: 'GF' });
  await receive(REGION_REPLIES.VN);
  expect(connection.settings.regionBand?.val).toBe('VN'); expect(connection.settings.regionBandError).toContain('SF');
  expect(log.mock.calls.every(call => call[1] === 'error')).toBe(true);
  expect(actions.isPending()).toBe(false);
});
it('keeps UART error code and actual post-error subset; no SET retry or unrelated writes', async () => {
  await read(); log.mockClear(); await apply();
  await receive({ cmd: 'SF', status: 'err', error: 'module_error', code: 254 });
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('module_error (254)'), 'error', expect.anything());
  await start({ id: 'profile', mode: 'apply', value: 13 }); expect(send).toHaveBeenCalledTimes(2);
  await advance(1000); await receive(SUBSET_REPLY);
  expect(connection.settings.regionBand).toMatchObject({ val: 'CUSTOM', mode: 'subset', minCh: 2, maxCh: 5 });
  expect(send.mock.calls.map(call => call[0].cmd)).toEqual(['GF', 'SF', 'GF']);
});
it('uses a five-second Apply deadline through the additional GF verification', async () => {
  await read(); log.mockClear(); await apply();
  await advance(4500); await receive(ack());
  expect(send).toHaveBeenLastCalledWith({ cmd: 'GF' });
  await advance(499); expect(log).not.toHaveBeenCalled();
  await advance(1);
  expect(log).toHaveBeenLastCalledWith(expect.any(String), 'error', expect.objectContaining({ title: 'Apply not confirmed' }));
  expect(connection.settings.regionBandConfirmed).toBe(false);
});
it('does not accept GLP, a value-only SF or a late saved ACK after timeout', async () => {
  await read(); log.mockClear(); await apply();
  await receive({ cmd: 'SF', val: 'VN' }); await receive({ cmd: 'GLP', val: 15, format: 2 });
  await advance(4999); expect(log).not.toHaveBeenCalled();
  await advance(1); await receive(ack());
  expect(send.mock.calls.map(call => call[0].cmd)).toEqual(['GF', 'SF']);
  await advance(1000); await receive(REGION_REPLIES.VN);
  expect(log.mock.calls.some(call => call[2]?.title === 'Đã lưu')).toBe(false);
});
it('requires a new recovery read before another configuration write after recovery failure', async () => {
  await read(); await apply(); await receive({ cmd: 'SF', status: 'err', error: 'region_mismatch' });
  await advance(6000);
  await start({ id: 'profile', mode: 'apply', value: 13 });
  await advance(1000);
  expect(send.mock.calls.map(call => call[0].cmd)).toEqual(['GF', 'SF', 'GF', 'GF']);
  await receive(REGION_REPLIES.VN);
  expect(send).toHaveBeenLastCalledWith({ cmd: 'SLP', val: 13 });
});
it('handles legacy msg:busy by waiting for the active profile transaction before retrying SF', async () => {
  await read(); log.mockClear(); await apply();
  await receive({ cmd: 'SF', status: 'err', msg: 'busy' });
  await advance(1500); expect(send).toHaveBeenCalledTimes(2);
  await receive({ cmd: 'SLP', status: 'ok', val: 13, format: 2, persisted: true });
  expect(send.mock.calls.map(call => call[0].cmd)).toEqual(['GF', 'SF', 'SF']);
  await receive(ack()); await receive(REGION_REPLIES.VN);
  expect(log).toHaveBeenLastCalledWith(expect.any(String), 'info', expect.objectContaining({ title: 'Đã lưu' }));
});
it('marks initial GF timeout unavailable, suppresses automatic repeats and allows manual retry', async () => {
  await start({ id: 'region-band', mode: 'read' }); await advance(5000);
  expect(connection.settings).toMatchObject({ regionBandConfirmed: false, regionBandSupport: 'unavailable' });
  await act(async () => { await actions.runSequence([{ id: 'region-band', mode: 'read' }], { silent: true }); });
  expect(send).toHaveBeenCalledOnce();
  await receive(REGION_REPLIES.VN); expect(connection.settings.regionBand).toBeUndefined();
  await start({ id: 'region-band', mode: 'read' }); await advance(1000); await receive(REGION_REPLIES.VN);
  expect(connection.settings).toMatchObject({ regionBandConfirmed: true, regionBandSupport: 'supported' });
});
it('does not re-enable unsupported SF merely because recovery GF succeeds', async () => {
  await read(); await apply(); await receive({ cmd: 'SF', status: 'err', error: 'unknown_command' });
  await advance(1000); await receive(REGION_REPLIES.US);
  expect(connection.settings).toMatchObject({ regionBandSupport: 'unavailable', regionBandConfirmed: true });
  await apply(); expect(send.mock.calls.filter(call => call[0].cmd === 'SF')).toHaveLength(1);
});
it('disconnect invalidates cached region and cancels cooldown without retrying on the new connection', async () => {
  await read(); await apply(); await receive({ cmd: 'SF', status: 'err', error: 'interrupted' });
  await act(async () => { connection.handleConnectionStatusChange('disconnected'); root.render(<Harness status="disconnected" />); });
  await advance(10000); expect(send).toHaveBeenCalledTimes(2); expect(actions.isPending()).toBe(false);
  expect(connection.settings).toMatchObject({ regionBandConfirmed: false, regionBand: { val: 'US' } });
  await act(async () => root.render(<Harness />));
  await apply(); expect(send).toHaveBeenLastCalledWith({ cmd: 'GF' });
  await receive(REGION_REPLIES.US);
  expect(send).toHaveBeenLastCalledWith({ cmd: 'SF', val: 'VN', save: true });
});
it('changing Region leaves power, profile, Q and session unchanged', async () => {
  await receive({ cmd: 'GP', val: 22 }); await receive({ cmd: 'GLP', val: 5185, format: 2 }); await receive({ cmd: 'GQS', val: '6,255' });
  await read(); await apply(); await receive(ack()); await receive(REGION_REPLIES.VN);
  expect(connection.settings).toMatchObject({ power: 22, linkProfile: 5185, qValue: 6, session: 255 });
  expect(send.mock.calls.map(call => call[0].cmd)).toEqual(['GF', 'SF', 'GF']);
});

it('cancels a pending cooldown on unmount without another command', async () => {
  await read(); await apply(); await receive({ cmd: 'SF', status: 'err', error: 'tx_failed' });
  await act(async () => root.render(null));
  await advance(10000);
  expect(send).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
});
it('does not accept saved:true for a requested temporary apply', async () => {
  await read(); log.mockClear(); await apply('VN', false); await receive(ack('VN', true));
  await advance(1000); await receive(REGION_REPLIES.VN);
  expect(log.mock.calls.every(call => call[1] === 'error')).toBe(true);
});

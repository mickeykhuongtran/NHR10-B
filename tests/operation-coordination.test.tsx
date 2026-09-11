import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App';

let captured: any;
const mocks = vi.hoisted(() => ({
  stopScan: vi.fn(), startScan: vi.fn(), stopLocate: vi.fn(), resetLocate: vi.fn(), addLog: vi.fn(),
  scan: { isScanning: false, activeScanType: null, stopScan: vi.fn(), resetScanSession: vi.fn(), handleDataReceived: vi.fn() },
  connection: { status: 'connected', connectionRevision: 0, logs: [], settings: { linkProfile: 15, linkProfileFormat: 2, linkProfileConfirmed: true }, addLog: vi.fn(), setInventoryActive: vi.fn(), handleDataReceived: vi.fn() },
  ble: { setCallbacks: vi.fn(), writeEpc: vi.fn(), sendCommand: vi.fn() },
}));
vi.mock('../components/dashboard/DashboardLayout', () => ({ DashboardLayout: (props: any) => { captured = props; return <div />; } }));
vi.mock('../services/bleService', () => ({ bleService: mocks.ble }));
vi.mock('../hooks/useRFIDConnection', () => ({ useRFIDConnection: () => ({ ...mocks.connection, addLog: mocks.addLog }) }));
vi.mock('../hooks/useScanLogic', () => ({ useScanLogic: () => ({ ...mocks.scan, stopScan: mocks.stopScan, startScan: mocks.startScan }) }));
vi.mock('../hooks/useLocateLogic', () => ({ useLocateLogic: () => ({ isLocating: false, stopLocate: mocks.stopLocate, resetLocateState: mocks.resetLocate, handleDataReceived: vi.fn() }) }));
vi.mock('../hooks/useFileTransfer', () => ({ useFileTransfer: () => ({ transferStatus: 'idle' }) }));
let root: Root;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.connection.status = 'connected';
  mocks.connection.connectionRevision = 0;
  mocks.connection.settings = { linkProfile: 15, linkProfileFormat: 2, linkProfileConfirmed: true };
  mocks.stopScan.mockResolvedValue(undefined); mocks.startScan.mockResolvedValue(undefined); mocks.ble.writeEpc.mockResolvedValue(undefined);
  mocks.ble.sendCommand.mockResolvedValue(undefined);
  root = createRoot(document.createElement('div'));
  act(() => root.render(<App />));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it('finishes a scan stop without sending an extra locate stop command', async () => {
  await act(async () => captured.onStopScan());
  expect(mocks.stopScan).toHaveBeenCalledOnce();
  expect(mocks.stopLocate).not.toHaveBeenCalled();
  expect(mocks.resetLocate).toHaveBeenCalledOnce();
});

it('blocks a new scan until the stop command sequence has finished', async () => {
  let finish!: () => void;
  mocks.stopScan.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  let stop!: Promise<void>;
  act(() => { stop = captured.onStopScan(); });
  expect(captured.commandPending).toBe(true);
  await act(async () => captured.onStartScan());
  expect(mocks.startScan).not.toHaveBeenCalled();
  await act(async () => { finish(); await stop; });
  expect(captured.commandPending).toBe(false);
  await act(async () => captured.onStartScan());
  expect(mocks.startScan).toHaveBeenCalledOnce();
});

it('does not leave a write pending indefinitely without a firmware response', async () => {
  await act(async () => captured.onWriteEpc('', 'E20000112233445566778899'));
  expect(captured.writeStatus).toBe('pending');
  act(() => vi.advanceTimersByTime(10000));
  expect(captured.writeStatus).toBe('error');
  expect(captured.writeMessage).toContain('verify');
});

it('reports each write attempt once, including repeated results, without accepting duplicate replies', async () => {
  const reply = (data: object) => act(() => mocks.ble.setCallbacks.mock.calls.at(-1)![0](data));
  await act(async () => captured.onWriteEpc('', 'AABBCCDD'));
  reply({ cmd: 'WD', status: 'ok' });
  expect(captured.writeStatus).toBe('success');
  expect(mocks.addLog).toHaveBeenLastCalledWith(expect.stringContaining('verify'), 'info', { id: 'write-1', title: 'Write confirmed' });
  const calls = mocks.addLog.mock.calls.length;
  reply({ cmd: 'WD', status: 'ok' }); expect(mocks.addLog).toHaveBeenCalledTimes(calls);
  await act(async () => captured.onWriteEpc('', 'AABBCCDD'));
  reply({ cmd: 'WE', status: 'err', code: 0 });
  expect(captured.writeStatus).toBe('error');
  expect(mocks.addLog).toHaveBeenLastCalledWith(expect.stringContaining('(0)'), 'error', { id: 'write-2', title: 'Write needs attention' });
});
it('reports transport failures and disconnects as timed user notices', async () => {
  mocks.ble.writeEpc.mockRejectedValueOnce(new Error('GATT failed'));
  await act(async () => captured.onWriteEpc('', 'AABBCCDD'));
  expect(captured.writeStatus).toBe('error');
  expect(mocks.addLog).toHaveBeenLastCalledWith(expect.stringContaining('GATT failed'), 'error', expect.objectContaining({ id: 'write-1' }));
  await act(async () => captured.onWriteEpc('', 'AABBCCDD'));
  mocks.connection.status = 'disconnected'; act(() => root.render(<App />));
  expect(captured.writeStatus).toBe('error');
  expect(mocks.addLog).toHaveBeenLastCalledWith(expect.stringContaining('Connection lost'), 'error', expect.objectContaining({ id: 'write-2' }));
});
it('blocks duplicate write calls and mode changes while waiting for a write response', async () => {
  await act(async () => captured.onWriteEpc('', 'AABBCCDD'));
  await act(async () => captured.onWriteEpc('', '11223344'));
  await act(async () => captured.onStartScan());
  expect(mocks.ble.writeEpc).toHaveBeenCalledOnce(); expect(mocks.startScan).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(10000));
  expect(mocks.addLog).toHaveBeenLastCalledWith(expect.stringContaining('No write response'), 'error', expect.objectContaining({ id: 'write-1' }));
});

it('blocks scans and tag writes until a settings response is verified', async () => {
  await act(async () => { void captured.onSettingsAction({ id: 'power', mode: 'read' }); });
  expect(captured.settingsActivity?.phase).toBe('Reading');
  await act(async () => captured.onStartScan());
  await act(async () => captured.onWriteEpc('', 'AABBCCDD'));
  expect(mocks.startScan).not.toHaveBeenCalled(); expect(mocks.ble.writeEpc).not.toHaveBeenCalled();
  await act(async () => mocks.ble.setCallbacks.mock.calls.at(-1)![0]({ cmd: 'GP', val: 20 }));
  expect(captured.settingsActivity).toBeNull();
  await act(async () => captured.onStartScan()); expect(mocks.startScan).toHaveBeenCalledOnce();
});

const settingsReply = async (data: object) => { await act(async () => { mocks.ble.setCallbacks.mock.calls.at(-1)![0](data); }); };
it.each([
  [2, 'standard', 15, 4, 1, 1], [2, 'quick', 11, 2, 0, 0], [2, 'deep', 13, 4, 1, 1], [1, 'standard', 53, 4, 1, 1],
])('serializes the full Scan preset for format %i, %s', async (format, mode, profile, q, session, focus) => {
  mocks.connection.settings.linkProfileFormat = Number(format);
  act(() => root.render(<App />));
  let pending!: Promise<void>;
  await act(async () => { pending = captured.onApplyPreset(mode); });
  const val = `${profile},${q},${session},0`;
  expect(mocks.ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'SRP', val });
  await act(async () => captured.onStartScan()); expect(mocks.startScan).not.toHaveBeenCalled();
  await settingsReply({ cmd: 'SRP', status: 'ok', persisted: true, val, format });
  expect(mocks.ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GRP' });
  await settingsReply({ cmd: 'GRP', val, format });
  expect(mocks.ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'TF', val: focus });
  await settingsReply({ cmd: 'TF', status: 'ok' });
  expect(mocks.ble.sendCommand).toHaveBeenLastCalledWith({ cmd: 'GTF' });
  await settingsReply({ cmd: 'GTF', val: focus });
  await pending;
  expect(captured.commandPending).toBe(false);
});
it('reads GLP first on every reconnect and waits for each setting response before the next request', async () => {
  const replies = [
    { cmd: 'GLP', val: 13, format: 2 }, { cmd: 'GDN', val: 'NHR10-TEST' }, { cmd: 'GP', val: 20 },
    { cmd: 'GQS', val: '6,255' }, { cmd: 'GQP', val: '30,2,0' }, { cmd: 'GTF', val: 1 }, { cmd: 'GF', status: 'ok', val: 'US', band: 2, min_ch: 0, max_ch: 49, start_khz: 902750, end_khz: 927250, count: 50, step_khz: 500 },
  ];
  for (let revision = 1; revision <= 2; revision++) {
    mocks.connection.status = 'disconnected'; await act(async () => root.render(<App />));
    mocks.connection.status = 'connected'; mocks.connection.connectionRevision = revision;
    const before = mocks.ble.sendCommand.mock.calls.length;
    await act(async () => root.render(<App />));
    for (let index = 0; index < replies.length; index++) {
      expect(mocks.ble.sendCommand).toHaveBeenCalledTimes(before + index + 1);
      expect(mocks.ble.sendCommand).toHaveBeenLastCalledWith({ cmd: replies[index].cmd });
      await settingsReply(replies[index]);
    }
    expect(captured.settingsActivity).toBeNull();
  }
});

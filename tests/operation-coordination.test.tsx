import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App';

let captured: any;
const mocks = vi.hoisted(() => ({
  stopScan: vi.fn(), startScan: vi.fn(), stopLocate: vi.fn(), resetLocate: vi.fn(), addLog: vi.fn(),
  scan: { isScanning: false, activeScanType: null, stopScan: vi.fn(), resetScanSession: vi.fn(), handleDataReceived: vi.fn() },
  connection: { status: 'connected', logs: [], settings: {}, addLog: vi.fn(), setInventoryActive: vi.fn(), handleDataReceived: vi.fn() },
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

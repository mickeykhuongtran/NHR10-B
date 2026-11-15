import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFileTransfer } from '../hooks/useFileTransfer';
import { parseNhrbFile } from '../utils/nhrbParser';

const ble = vi.hoisted(() => ({ requestFileTransfer: vi.fn() }));
vi.mock('../services/bleService', () => ({ bleService: ble }));
// REVB command_processor.c wire layout; payload CRC independently checked with
// Python zlib.crc32 = 0x72fd6b50. Do not derive the fixture with the parser.
const golden = () => Uint8Array.from(Buffer.from(
  '4e485242012001110200000022000000506bfd720000000010000000000000000ce280689400005035e6130838000000000411223344000000000000000000000000', 'hex'));
const epcs = ['E280689400005035E6130838', '11223344'];
const addLog = vi.fn();
let transfer: ReturnType<typeof useFileTransfer>;
let root: Root;
function Harness() { transfer = useFileTransfer(addLog); return null; }
beforeEach(() => {
  vi.useFakeTimers(); addLog.mockReset(); ble.requestFileTransfer.mockReset().mockResolvedValue(undefined);
  root = createRoot(document.createElement('div')); act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });

it('reads the firmware binary format without assuming a zero buffer offset', () => {
  const container = new Uint8Array(golden().length + 8); container.set(golden(), 5);
  const parsed = parseNhrbFile(container.subarray(5, -3));
  expect(parsed.epcs).toEqual(epcs);
  expect(parsed.header).toMatchObject({ recordCount: 2, payloadBytes: 34, payloadCrc32: 0x72fd6b50, maxEpcLenBytes: 16 });
});

it.each([[0, 0, 'magic'], [4, 2, 'version'], [5, 31, 'header length'], [6, 2, 'format ID'],
  [7, 18, 'record size'], [8, 3, 'payload size'], [12, 35, 'payload size'], [24, 17, 'max EPC length'],
  [33, 0, 'CRC']])('rejects malformed batch metadata/data at byte %s', (offset, value, reason) => {
  const bytes = golden(); bytes[offset as number] = value as number;
  expect(() => parseNhrbFile(bytes)).toThrow(reason as string);
});

it('rejects truncated or trailing bytes instead of publishing partial EPCs', () => {
  expect(() => parseNhrbFile(golden().subarray(0, 31))).toThrow('shorter');
  expect(() => parseNhrbFile(golden().subarray(0, -1))).toThrow('file size');
  const extra = new Uint8Array(golden().length + 1); extra.set(golden());
  expect(() => parseNhrbFile(extra)).toThrow('file size');
});

it('completes batch fetch and clears stale results when a new file is corrupt', async () => {
  await act(async () => transfer.fetchHistory());
  expect(transfer.transferStatus).toBe('requesting');
  act(() => {
    transfer.handleFileCallback('request');
    transfer.handleFileCallback('start', { total: golden().length, chunks: 2 });
    transfer.handleFileCallback('progress', 50);
  });
  expect(transfer.transferProgress).toBe(50);
  act(() => transfer.handleFileCallback('complete', golden().buffer));
  expect(transfer.historyData).toEqual(epcs.map((EPC, index) => ({ INDEX: index + 1, EPC })));
  expect(transfer.transferStatus).toBe('complete');
  expect(transfer.isFileTransferring).toBe(false);
  const corrupt = golden(); corrupt[33] ^= 1;
  act(() => transfer.handleFileCallback('complete', corrupt));
  expect(transfer.historyData).toEqual([]);
  expect(transfer.transferStatus).toBe('error');
  expect(addLog).toHaveBeenLastCalledWith(expect.stringContaining('CRC'), 'error');
});

it('retries a saving device at 1200 ms and stops after eight busy retries', async () => {
  await act(async () => transfer.fetchHistory());
  for (let i = 0; i < 8; i++) {
    act(() => transfer.handleFileCallback('busy'));
    expect(transfer.transferStatus).toBe('saving');
    await act(async () => vi.advanceTimersByTimeAsync(1199));
    expect(ble.requestFileTransfer).toHaveBeenCalledTimes(i + 1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(ble.requestFileTransfer).toHaveBeenCalledTimes(i + 2);
  }
  act(() => transfer.handleFileCallback('busy'));
  expect(transfer.transferStatus).toBe('error');
  expect(transfer.isFileTransferring).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(ble.requestFileTransfer).toHaveBeenCalledTimes(9);
});

it.each(['clear', 'error', 'complete', 'unmount'])('cancels a scheduled retry on %s', async action => {
  act(() => transfer.handleFileCallback('busy'));
  act(() => {
    if (action === 'clear') transfer.clearFileData();
    else if (action === 'unmount') root.render(null);
    else transfer.handleFileCallback(action, action === 'complete' ? golden() : 'link lost');
  });
  await act(async () => vi.advanceTimersByTimeAsync(1200));
  expect(ble.requestFileTransfer).not.toHaveBeenCalled();
  if (action === 'clear') expect(transfer.transferStatus).toBe('idle');
});

it('reports rejected initial and retried transfers without remaining busy', async () => {
  ble.requestFileTransfer.mockRejectedValue(new Error('disconnected'));
  await act(async () => transfer.fetchHistory());
  expect(transfer.transferStatus).toBe('error');
  expect(transfer.isFileTransferring).toBe(false);
  act(() => transfer.handleFileCallback('busy'));
  await act(async () => vi.advanceTimersByTimeAsync(1200));
  expect(transfer.transferStatus).toBe('error');
  expect(transfer.isFileTransferring).toBe(false);
});

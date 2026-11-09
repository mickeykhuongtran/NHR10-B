import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useScanLogic } from '../hooks/useScanLogic';
import { ScannerTab } from '../components/dashboard/ScannerTab';

vi.mock('react-virtualized-auto-sizer', () => ({ default: ({ children }: any) => children({ height: 600, width: 1000 }) }));
vi.mock('../services/bleService', () => ({ bleService: {
  resumeLiveTags: vi.fn(), suspendLiveTags: vi.fn(), startScan: vi.fn(), stopScan: vi.fn(),
} }));

const A = 'E20000000000000000000001';
const B = 'E20000000000000000000002';
const NOISE = 'E200000000000000000000FF';
const noop = vi.fn();
let scan: ReturnType<typeof useScanLogic>;
let root: Root;
let container: HTMLDivElement;

function Harness({ showScanner = true }: { showScanner?: boolean }) {
  scan = useScanLogic(noop);
  return showScanner ? <ScannerTab
    isConnected isConnecting={false} isBusy={false} onConnect={noop}
    isScanning={scan.isScanning} activeScanType={scan.activeScanType}
    scanStartedAt={scan.scanStartedAt} scanStoppedAt={scan.scanStoppedAt}
    removeStaleTags={scan.removeStaleTags} staleRemoveMs={scan.staleRemoveMs}
    onChangeRemoveStaleTags={scan.setRemoveStaleTags} onChangeStaleRemoveMs={scan.setStaleRemoveMs}
    onStartScan={scan.startScan} onStopScan={scan.stopScan} onStartBatch={scan.startBatch} onStopBatch={scan.stopScan}
    onClear={scan.clearTags} tags={scan.tags} stats={scan.stats} exclusions={scan.exclusions}
    profileFormat={1} profileConfirmed
    onApplyPreset={noop} isBatchSaving={false} batchSaveInfo={{ state: 'idle', progress: 0, written: 0, total: 0 }}
    onChooseTag={noop} onOpenStorage={noop}
  /> : null;
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const receive = (...d: [string, number, number, number][]) => act(() => scan.handleDataReceived({ cmd: 'live_tags', d }));
const control = (cmd: string) => act(() => scan.handleDataReceived({ cmd }));
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!;
const click = (label: string) => act(() => button(label).click());
const view = (label: 'Live' | 'Excluded') => act(() => {
  [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Result view"] button')].find(b => b.textContent?.startsWith(label))!.click();
});
const row = (epc: string) => [...container.querySelectorAll('[role="row"]')].find(r => r.textContent?.includes(epc))!;
const metric = (label: string) => [...container.querySelectorAll('.scan-metric-compact')].find(m => m.firstElementChild?.textContent === label)?.lastElementChild?.textContent;
const seed = () => {
  receive([A, -50, 10, 10], [B, -60, 2, 2], [NOISE, -40, 100, 100]);
  advance(20);
};
const excludeTargets = () => act(() => { scan.exclusions.excludeTag(A); scan.exclusions.excludeTag(B); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T01:00:00Z'));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
  control('S');
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('shows only the selected group counts and rates, with live RSSI and detection status', () => {
  seed();
  act(() => row(A).querySelectorAll<HTMLButtonElement>('button')[2].click());
  act(() => scan.exclusions.excludeTag(B));
  expect(metric('Total reads')).toBe('100');
  view('Excluded');
  expect(metric('Tags read / tracked')).toBe('2 / 2');
  expect(metric('Total reads')).toBe('12');
  expect(metric('Reading now')).toBe('2');
  expect(row(A).textContent).toContain('Reading');
  expect(row(NOISE)).toBeUndefined();
  receive([A, -47, 3, 13], [NOISE, -30, 150, 250]);
  advance(520);
  expect(metric('Total reads')).toBe('15');
  expect(row(A).textContent).toContain('-47 dBm');
  expect(scan.exclusions.stats.readsPerSecond).toBeGreaterThan(0);
  expect(scan.stats.readsPerSecond / scan.exclusions.stats.readsPerSecond).toBeCloseTo(50);
  view('Live');
  expect(metric('Total reads')).toBe('250');
});

it('clears excluded measurements during scanning without losing EPCs or changing Live', () => {
  seed(); excludeTargets(); view('Excluded');
  // Clear between BLE delivery and the next render: this unpublished total must
  // also become the baseline, or old reads leak into the next measurement.
  receive([A, -45, 5, 15], [NOISE, -30, 100, 200]);
  click('Clear excluded');
  expect(scan.isScanning).toBe(true);
  expect(scan.stats.totalReads).toBe(200);
  expect(scan.exclusions.tags.map(t => t.epc)).toEqual([A, B]);
  expect(metric('Tags read / tracked')).toBe('0 / 2');
  expect(metric('Total reads')).toBe('0');
  expect(metric('Reads / second')).toBe('0');
  expect(metric('Reading now')).toBe('0');
  expect(row(A).textContent).toContain('Not read yet');
  expect(row(A).textContent).not.toContain('dBm');
  expect(button('Clear excluded').disabled).toBe(true);
  receive([A, -49, 1, 16]); advance(520);
  expect(scan.exclusions.tags.find(t => t.epc === A)?.count).toBe(1);
  expect(scan.exclusions.tags.find(t => t.epc === B)?.count).toBe(0);
  expect(metric('Tags read / tracked')).toBe('1 / 2');
  expect(metric('Total reads')).toBe('1');
  expect(scan.stats.totalReads).toBe(200);
  click('Clear excluded');
  receive([A, -48, 2, 18]); advance(520);
  expect(metric('Total reads')).toBe('2');
});

it('clears only Live results and preserves the tracked group measurements', () => {
  seed(); excludeTargets();
  click('Clear results');
  expect(scan.stats.totalReads).toBe(0);
  expect(scan.exclusions.stats.totalReads).toBe(12);
  receive([NOISE, -30, 3, 103]); advance(520);
  expect(scan.stats.totalReads).toBe(3);
  expect(scan.exclusions.stats.totalReads).toBe(12);
});

it('keeps stale excluded rows and counts while rates fall to zero, then detects rereads', () => {
  seed(); excludeTargets(); view('Excluded');
  act(() => scan.setRemoveStaleTags(true));
  advance(4000);
  expect(scan.tags).toHaveLength(0);
  expect(metric('Tags read / tracked')).toBe('2 / 2');
  expect(metric('Reading now')).toBe('0');
  expect(metric('Reads / second')).toBe('0');
  expect(metric('Total reads')).toBe('12');
  expect(row(A).textContent).toContain('Not seen recently');
  receive([A, -48, 1, 11], [NOISE, -30, 5, 105]); advance(520);
  expect(metric('Reading now')).toBe('1');
  expect(metric('Total reads')).toBe('13');
  expect(scan.stats.totalReads).toBe(105);
  expect(row(A).textContent).toContain('Reading');
});

it('retains membership but resets counts, signal and detection on a new scan or disconnect', () => {
  seed(); excludeTargets(); view('Excluded');
  control('X');
  expect(metric('Reading now')).toBe('0');
  expect(metric('Reads / second')).toBe('0');
  expect(row(A).textContent).toContain('Scan stopped');
  control('S');
  expect(metric('Tags read / tracked')).toBe('0 / 2');
  expect(metric('Total reads')).toBe('0');
  expect(row(A).textContent).toContain('Not read yet');
  receive([B, -55, 3, 3]); advance(520);
  expect(metric('Tags read / tracked')).toBe('1 / 2');
  expect(metric('Total reads')).toBe('3');
  act(() => scan.resetScanSession());
  expect(scan.exclusions.tags.map(t => t.epc)).toEqual([A, B]);
  expect(metric('Total reads')).toBe('0');
});

it('continues tracking while the scanner view is unmounted and restores current measurements', () => {
  seed(); excludeTargets();
  act(() => root.render(<Harness showScanner={false} />));
  receive([A, -49, 6, 16]); advance(520);
  act(() => root.render(<Harness />)); view('Excluded');
  expect(metric('Total reads')).toBe('18');
  act(() => row(A).querySelectorAll<HTMLButtonElement>('button')[2].click());
  expect(scan.exclusions.tags.map(t => t.epc)).toEqual([B]);
  expect(scan.stats.totalReads).toBe(116);
  click('Restore all');
  expect(scan.exclusions.tags).toHaveLength(0);
  expect(scan.stats.totalReads).toBe(118);
  expect(container.textContent).toContain('No excluded tags');
});

it('does not count duplicate totals as rereads and handles device counter resets after clear', () => {
  seed(); excludeTargets(); view('Excluded'); click('Clear excluded');
  receive([A, -50, 0, 10]); advance(520);
  expect(metric('Tags read / tracked')).toBe('0 / 2');
  receive([A, -50, 1, 1]); advance(520);
  expect(metric('Total reads')).toBe('1');
  receive([A, -50, 1, 4]); advance(520);
  // Cumulative firmware totals recover reads omitted from a notification.
  expect(metric('Total reads')).toBe('4');
});

it('keeps final counts and zero rates after stopping, ignoring late packets', () => {
  seed(); excludeTargets(); view('Excluded');
  receive([A, -45, 4, 14]);
  control('X'); advance(520);
  expect(metric('Total reads')).toBe('16');
  expect(metric('Reads / second')).toBe('0');
  receive([A, -30, 20, 34]); advance(1000);
  expect(metric('Total reads')).toBe('16');
  click('Clear excluded');
  expect(metric('Total reads')).toBe('0');
  expect(scan.exclusions.tags).toHaveLength(2);
});

it('renders tracked status and clear action in the mobile card view', () => {
  const width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
  act(() => root.render(<Harness showScanner={false} />));
  act(() => root.render(<Harness />));
  seed(); excludeTargets(); view('Excluded');
  expect(container.querySelector('[role="table"]')).toBeNull();
  expect(container.querySelectorAll('article')).toHaveLength(2);
  expect(container.querySelector('article')?.textContent).toContain('Reading');
  click('Clear excluded');
  expect(container.querySelectorAll('article')).toHaveLength(2);
  expect(container.querySelector('article')?.textContent).toContain('Not read yet');
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
});

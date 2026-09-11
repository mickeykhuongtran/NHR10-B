import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DashboardLayout } from '../components/dashboard/DashboardLayout';
import { OperationsTab } from '../components/dashboard/OperationsTab';
import { ScannedTagPicker } from '../components/dashboard/ScannedTagPicker';
import { parseRegionReading } from '../utils/regionBand';
import { REGION_REPLIES, SUBSET_REPLY, UNKNOWN_REPLY } from './region-fixtures';

vi.mock('react-virtualized-auto-sizer', () => ({ default: ({ children }: any) => children({ height: 300, width: 900 }) }));
vi.mock('../services/bleService', () => ({ bleService: { getSettings: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = (node: React.ReactNode) => act(() => root.render(node));
const buttons = () => [...container.querySelectorAll('button')];
const button = (label: string) => {
  const found = buttons().find(b => b.textContent?.trim() === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
};
const click = (label: string) => act(() => button(label).click());
const input = (label: string) => {
  const found = [...container.querySelectorAll('label')].find(l => l.textContent === label);
  return container.querySelector<HTMLInputElement>(`#${CSS.escape(found!.htmlFor)}`)!;
};
const targetPicker = () => container.querySelector<HTMLButtonElement>('[role="combobox"][aria-labelledby$="-label"]')!;
const fill = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
});
const fixture = (): React.ComponentProps<typeof DashboardLayout> => ({
  commandPending: false, settingsActivity: null, onSettingsAction: vi.fn(),
  status: 'disconnected', settings: {
    power: 20, buzzer: true, tagFocus: true, fastTid: false, linkProfile: 53, linkProfileFormat: 1, linkProfileConfirmed: true, qValue: 4, session: 1,
    scanParams: { interval: 30, dwell: 2, count: 0 }, version: 'test', temperature: 24,
    batterySnapshot: null, deviceInfo: '', deviceName: '', deviceCanonicalId: '',
  },
  tags: [], logs: [], scanStats: { visibleTags: 0, totalReads: 0, readsPerSecond: 0, uniquePerSecond: 0, averageRssi: null, peakRssi: null },
  isScanning: false, scanStartedAt: null, scanStoppedAt: null, removeStaleTags: false, staleRemoveMs: 3000,
  onChangeRemoveStaleTags: vi.fn(), onChangeStaleRemoveMs: vi.fn(), onConnect: vi.fn(), onDisconnect: vi.fn(),
  activeScanType: null, onStartScan: vi.fn(), onStopScan: vi.fn(), onStartBatch: vi.fn(), onStopBatch: vi.fn(), onClearTags: vi.fn(),
  onLocate: vi.fn(), onStopLocate: vi.fn(), targetRssi: null, isLocating: false, locateSignalState: 'idle',
  onWriteEpc: vi.fn(), onWriteData: vi.fn(), writeStatus: 'idle', writeMessage: '',
  onRefreshSettings: vi.fn(), onFetchHistory: vi.fn(), onDownloadJson: vi.fn(), onDownloadCsv: vi.fn(),
  onDownloadTxt: vi.fn(), onShare: vi.fn(), onClearFileData: vi.fn(), historyData: [], isBatchSaving: false,
  batchSaveInfo: { state: 'idle', progress: 0, written: 0, total: 0 }, onDownloadLogs: vi.fn(), onClearLogs: vi.fn(),
  isFileTransferring: false, transferProgress: 0, transferStatus: 'idle', onApplyPreset: vi.fn(), onShowPopup: vi.fn(),
});

it('shows the current Bluetooth name with a Read button and no rename controls', () => {
  const props = fixture(); props.status = 'connected'; props.settings.deviceName = 'NHR-10';
  render(<DashboardLayout {...props} />); click('Advanced'); click('Device settings');
  const card = () => container.querySelector<HTMLElement>('section[aria-label="Bluetooth Device Name"]')!;
  expect(card().textContent).toContain('NHR-10');
  expect(card().querySelectorAll('input')).toHaveLength(0);
  expect([...card().querySelectorAll('button')].map(b => b.textContent)).toEqual(['Read']);
  act(() => card().querySelector('button')!.click());
  expect(props.onSettingsAction).toHaveBeenCalledExactlyOnceWith({ id: 'device-name', mode: 'read' });
  render(<DashboardLayout {...props} settings={{ ...props.settings, deviceName: 'Name from DI' }} />);
  expect(card().textContent).toContain('Name from DI');
  render(<DashboardLayout {...props} status="disconnected" />);
  expect(card().textContent).toContain('Not read from device');
  act(() => card().querySelector('button')!.click());
  expect(props.onSettingsAction).toHaveBeenCalledOnce();
});

it('starts with the EPC inventory focused and keeps optional guidance and engineering tools collapsed', () => {
  render(<DashboardLayout {...fixture()} />);
  expect(container.querySelector('h1')?.textContent).toBe('Scan tags');
  expect(button('Start scan').disabled).toBe(true);
  expect(container.querySelector('#scan-guide')).toBeNull();
  expect(button('Quick guide')).not.toBeNull();
  expect(container.querySelector('[aria-label="Tag results"]')?.textContent).toContain('Primary workspace');
  expect(container.textContent).not.toContain('Develop');
  expect(buttons().some(b => b.textContent === 'Diagnostics')).toBe(false);
  click('Advanced');
  click('Diagnostics');
  expect(container.querySelector('h1')?.textContent).toBe('Diagnostics');
});

it('carries a scanned EPC directly into the find workflow', async () => {
  const props = fixture(); props.status = 'connected';
  props.tags = [{ epc: 'E20000112233445566778899', timestamp: 100, count: 4, rssi: -67 }];
  render(<DashboardLayout {...props} />);
  click('Find tag');
  expect(input('Target EPC').value).toBe(props.tags[0].epc);
  await act(async () => button('Start finding').click());
  expect(props.onLocate).toHaveBeenCalledWith(props.tags[0].epc);
});

it('keeps a stop action available across tabs and blocks conflicting commands', () => {
  const props = fixture(); props.status = 'connected'; props.isScanning = true; props.activeScanType = 'interactive';
  render(<DashboardLayout {...props} />);
  act(() => buttons().find(b => b.textContent?.includes('Find a tag'))!.click());
  fill(input('Target EPC'), 'E20000112233445566778899');
  expect(button('Start finding').disabled).toBe(true);
  click('Stop scan'); expect(props.onStopScan).toHaveBeenCalledOnce();
  click('Advanced'); click('Device settings');
  expect(container.querySelector('fieldset')?.disabled).toBe(true);
});

it('requires valid EPC data and explicit confirmation before writing', () => {
  const props = { isConnected: true, isBusy: false, tags: [], onWriteEpc: vi.fn(), onWriteData: vi.fn(), writeStatus: 'idle' as const };
  render(<OperationsTab {...props} />);
  fill(input('New EPC (hexadecimal)'), 'ZZZZ');
  expect(button('Review & write EPC').disabled).toBe(true);
  fill(input('New EPC (hexadecimal)'), 'E20000112233445566778899');
  click('Review & write EPC');
  expect(container.querySelector('dialog')?.open).toBe(true);
  expect(props.onWriteEpc).not.toHaveBeenCalled();
  click('Confirm write');
  expect(props.onWriteEpc).toHaveBeenCalledWith('', 'E20000112233445566778899', undefined);
});

it('filters retained diagnostic logs without changing the exported report', () => {
  const props = fixture(); props.logs = [{ type: 'rx', timestamp: 1, message: 'Battery sample' }, { type: 'error', timestamp: 2, message: 'TX failed' }];
  render(<DashboardLayout {...props} />); click('Advanced'); click('Diagnostics');
  const filter = container.querySelector<HTMLSelectElement>('[aria-label="Filter log events"]')!;
  act(() => { filter.value = 'error'; filter.dispatchEvent(new Event('change', { bubbles: true })); });
  const logView = container.querySelector('[aria-label="Device communication events"]');
  expect(logView?.textContent).toContain('TX failed'); expect(logView?.textContent).not.toContain('Battery sample');
  click('Export service report'); expect(props.onDownloadLogs).toHaveBeenCalledOnce();
});

it('prevents a download while the reader is saving a batch', () => {
  const props = fixture(); props.status = 'connected'; props.isBatchSaving = true;
  render(<DashboardLayout {...props} />);
  act(() => buttons().find(b => b.textContent?.includes('Saved data'))!.click());
  expect(button('Get saved data').disabled).toBe(true);
  expect(props.onFetchHistory).not.toHaveBeenCalled();
});

it('keeps the same status container and scan content while a device command is pending', () => {
  const props = fixture(); props.status = 'connected'; render(<DashboardLayout {...props} />);
  const activity = container.querySelector('[aria-label="Device activity"]');
  const controls = container.querySelector('[aria-label="Scan controls"]');
  const children = controls!.childElementCount;
  render(<DashboardLayout {...props} commandPending />);
  expect(container.querySelector('[aria-label="Device activity"]')).toBe(activity);
  expect(activity?.textContent).toContain('Waiting for device command');
  expect(controls!.childElementCount).toBe(children);
  expect(button('Start scan').disabled).toBe(true);
  expect(container.textContent).not.toContain('Finish the active operation');
  render(<DashboardLayout {...props} />); expect(button('Start scan').disabled).toBe(false);
});
it('shows lost state without a dBm reading or a nonzero meter, then recovers', () => {
  const props = fixture(); props.status = 'connected'; props.isLocating = true;
  render(<DashboardLayout {...props} locateSignalState="lost" />);
  act(() => buttons().find(b => b.textContent?.includes('Find a tag'))!.click());
  expect(container.querySelector('main')?.textContent).toContain('Tag lost');
  expect(container.querySelector('main')?.textContent).not.toContain('dBm');
  expect(container.querySelector('main [role="meter"]')?.getAttribute('aria-valuenow')).toBe('0');
  render(<DashboardLayout {...props} locateSignalState="detected" targetRssi={-63} />);
  expect(container.querySelector('main')?.textContent).toContain('Tag detected');
  expect(container.querySelector('main')?.textContent).toContain('-63dBm');
});
it('uses a selected scanned EPC as the actual write target and requires review', () => {
  const props = fixture(); props.status = 'connected';
  props.tags = [{ epc: 'E20000112233445566778899', timestamp: 100, count: 4, rssi: -67 }, { epc: 'AABB1122', timestamp: 101, count: 1, rssi: -70 }];
  render(<DashboardLayout {...props} />);
  act(() => buttons().find(b => b.textContent?.includes('Write EPC'))!.click());
  const advanced = [...container.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent?.includes('Advanced memory write'))!;
  act(() => { advanced.open = true; });
  const picker = targetPicker();
  act(() => picker.click());
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
  act(() => container.querySelectorAll<HTMLElement>('[role="option"]')[0].click());
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  expect(picker.textContent).toContain(props.tags[0].epc);
  const newEpcLabel = [...advanced.querySelectorAll('label')].find(l => l.textContent === 'New EPC (hexadecimal)')!;
  fill(container.querySelector<HTMLInputElement>(`#${CSS.escape(newEpcLabel.htmlFor)}`)!, 'E20099887766554433221100');
  click('Review memory write'); expect(props.onWriteEpc).not.toHaveBeenCalled();
  expect(container.querySelector('dialog')?.textContent).toContain(props.tags[0].epc);
  click('Confirm write');
  expect(props.onWriteEpc).toHaveBeenCalledWith(props.tags[0].epc, 'E20099887766554433221100', undefined);
  const notice = { type: 'info' as const, timestamp: 1000, message: 'The reader confirmed the write.', notice: { id: 'write-1', title: 'Write confirmed' } };
  render(<DashboardLayout {...props} writeStatus="success" writeMessage="Old inline message" logs={[notice]} />);
  expect(container.querySelector('main')?.textContent).not.toContain('Old inline message');
  expect(container.querySelector('.notification')?.textContent).toContain('Write confirmed');
});
it('allows target EPC selection only from scan results', () => {
  const props = { isConnected: true, isBusy: false, tags: [], onWriteEpc: vi.fn(), onWriteData: vi.fn(), writeStatus: 'idle' as const };
  render(<OperationsTab {...props} />);
  expect(targetPicker().disabled).toBe(true);
  expect(targetPicker().textContent).toContain('No scanned EPC available');
  const tags = Array.from({ length: 125 }, (_, index) => ({ epc: index.toString(16).padStart(8, '0').toUpperCase(), timestamp: 100, count: 1 }));
  render(<OperationsTab {...props} tags={tags} />);
  act(() => targetPicker().click());
  expect([...container.querySelectorAll('[role="option"]')].map(option => option.textContent)).toEqual(tags.map(tag => tag.epc));
  render(<OperationsTab {...props} />);
  expect(targetPicker().disabled).toBe(true);
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  expect(targetPicker().textContent).toContain('No scanned EPC available');
});

it('supports keyboard selection, dismissal and write locking in the inline EPC picker', () => {
  const tags = [{ epc: 'AABB1122', timestamp: 100, count: 1 }, { epc: 'CCDD3344', timestamp: 101, count: 2 }];
  const props = { tags, selectedEpc: '', onSelect: vi.fn() };
  render(<ScannedTagPicker {...props} />);
  const target = targetPicker();
  const key = (key: string) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
  target.focus(); key('ArrowDown'); key('ArrowDown');
  expect(document.getElementById(target.getAttribute('aria-activedescendant')!)?.textContent).toBe('CCDD3344');
  key('Enter'); expect(props.onSelect).toHaveBeenCalledWith('CCDD3344');
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(target);
  key('ArrowDown'); key('Escape'); expect(target.getAttribute('aria-expanded')).toBe('false');
  key('ArrowDown'); act(() => target.blur()); expect(container.querySelector('[role="listbox"]')).toBeNull();
  key('ArrowDown'); render(<ScannedTagPicker {...props} disabled />);
  expect(target.disabled).toBe(true); expect(container.querySelector('[role="listbox"]')).toBeNull();
});

it('explains every RF preset before applying one and retains its command mapping', async () => {
  const props = fixture(); props.status = 'connected'; render(<DashboardLayout {...props} />);
  const profiles = ['Standard', 'Quick', 'Deep'];
  for (const label of profiles) {
    const choice = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    expect(document.getElementById(choice.getAttribute('aria-describedby')!)?.textContent?.length).toBeGreaterThan(30);
    expect(choice.getAttribute('aria-pressed')).toBe('false');
  }
  const quick = container.querySelector<HTMLButtonElement>('[aria-label="Quick"]')!;
  await act(async () => quick.click());
  expect(props.onApplyPreset).toHaveBeenCalledWith('quick');
  expect(quick.getAttribute('aria-pressed')).toBe('true');
  expect(container.textContent).toContain('Profile 11, Q2, S0, Tag Focus off');
});

it('sends the chosen target, memory bank, pointer and password for advanced data writes', () => {
  const tag = { epc: 'E20000112233445566778899', timestamp: 100, count: 4 };
  const props = { isConnected: true, isBusy: false, tags: [tag], onWriteEpc: vi.fn(), onWriteData: vi.fn(), writeStatus: 'idle' as const };
  render(<OperationsTab {...props} />);
  act(() => targetPicker().click());
  act(() => container.querySelector<HTMLElement>('[role="option"]')!.click());
  const bank = container.querySelector<HTMLSelectElement>('#memory-bank')!;
  act(() => { bank.value = '3'; bank.dispatchEvent(new Event('change', { bubbles: true })); });
  fill(input('Word pointer'), '4'); fill(input('Access password (optional)'), '11223344'); fill(input('Data (hexadecimal words)'), 'AABBCCDD');
  click('Review memory write'); click('Confirm write');
  expect(props.onWriteData).toHaveBeenCalledWith(tag.epc, 3, 4, 'AABBCCDD', '11223344');
  expect(props.onWriteEpc).not.toHaveBeenCalled();
});

it('preserves settings button identity, focus, drafts and layout during telemetry and pending operations', () => {
  const props = fixture(); props.status = 'connected';
  render(<DashboardLayout {...props} />); click('Advanced'); click('Device settings');
  const profileCard = container.querySelector('[aria-label="RF Link Profile"]')!;
  const read = [...profileCard.querySelectorAll('button')].find(b => b.textContent === 'Read')!;
  const q = container.querySelector<HTMLSelectElement>('#setting-q')!;
  act(() => { q.value = '2'; q.dispatchEvent(new Event('change', { bubbles: true })); });
  read.focus(); act(() => read.click());
  expect(props.onSettingsAction).toHaveBeenCalledWith({ id: 'profile', mode: 'read' });
  const pending = { id: 'profile' as const, mode: 'read' as const, phase: 'Reading' as const, title: 'RF link profile' };
  render(<DashboardLayout {...props} settingsActivity={pending} logs={[{ type: 'rx', timestamp: 1, message: 'GB sample' }]} />);
  expect(container.querySelector('[aria-label="RF Link Profile"]')).toBe(profileCard);
  expect(profileCard.querySelector('button')).toBe(read); expect(document.activeElement).toBe(read);
  expect(q.value).toBe('2'); expect(container.querySelector<HTMLFieldSetElement>('[aria-label="Device configuration"]')?.disabled).toBe(false);
  act(() => read.click()); expect(props.onSettingsAction).toHaveBeenCalledOnce();
  render(<DashboardLayout {...props} />);
  expect(profileCard.querySelector('button')).toBe(read); expect(document.activeElement).toBe(read);
  expect(q.value).toBe('2');
});

it.each([1, 2] as const)('shows and applies the correct product profile options for format %i', format => {
  const props = fixture(); props.status = 'connected';
  props.settings = { ...props.settings, linkProfile: format === 1 ? 53 : 15, linkProfileFormat: format };
  render(<DashboardLayout {...props} />); click('Advanced'); click('Device settings');
  const select = container.querySelector<HTMLSelectElement>('#setting-profile')!;
  const card = container.querySelector('[aria-label="RF Link Profile"]')!;
  const apply = [...card.querySelectorAll('button')].find(button => button.textContent === 'Apply')!;
  expect(select.selectedOptions[0].textContent).toBe('STD — 640 kHz / Miller 4');
  expect([...select.options].map(option => option.textContent)).toEqual(['STD — 640 kHz / Miller 4', 'QUICK — 640 kHz / FM0', 'DEEP — 160 kHz / Miller 8']);
  for (const val of [format === 1 ? 53 : 15, 11, 13]) {
    act(() => { select.value = String(val); select.dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => apply.click());
    expect(props.onSettingsAction).toHaveBeenLastCalledWith({ id: 'profile', mode: 'apply', value: val });
  }
});
it.each([0, 5185, 65535])('keeps custom profile %i visible and applies the complete ID', val => {
  const props = fixture(); props.status = 'connected'; props.settings.linkProfile = val; props.settings.linkProfileFormat = 2;
  render(<DashboardLayout {...props} />); click('Advanced'); click('Device settings');
  const select = container.querySelector<HTMLSelectElement>('#setting-profile')!;
  expect(select.value).toBe(String(val)); expect(select.selectedOptions[0].textContent).toBe(`${val} (device value)`);
  const apply = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="RF Link Profile"] button')].find(button => button.textContent === 'Apply')!;
  act(() => apply.click());
  expect(props.onSettingsAction).toHaveBeenLastCalledWith({ id: 'profile', mode: 'apply', value: val });
});
it('keeps an unknown format explicit and marks cached profile unconfirmed on reconnect', () => {
  const props = fixture(); props.status = 'connected'; props.settings.linkProfile = 15; props.settings.linkProfileFormat = null;
  render(<DashboardLayout {...props} />); click('Advanced'); click('Device settings');
  const select = container.querySelector<HTMLSelectElement>('#setting-profile')!;
  expect(select.options.length).toBe(1); expect(select.selectedOptions[0].textContent).toBe('15 (device value)');
  expect(container.textContent).toContain('Format unknown');
  props.settings = { ...props.settings, linkProfileConfirmed: false };
  render(<DashboardLayout {...props} />);
  expect(select.value).toBe('15'); expect(container.textContent).toContain('Unconfirmed');
  const apply = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="RF Link Profile"] button')].find(button => button.textContent === 'Apply')!;
  expect(apply.disabled).toBe(true);
  props.settings = { ...props.settings, linkProfileConfirmed: true, linkProfileFormat: 2 };
  render(<DashboardLayout {...props} />);
  expect(apply.disabled).toBe(false); expect(select.selectedOptions[0].textContent).toBe('STD — 640 kHz / Miller 4');
});

it('offers only US, ETSI and VN and keeps Region Apply/Save locked until a current GF succeeds', () => {
  const props = fixture(); props.status = 'connected';
  render(<DashboardLayout {...props} />); click('Advanced'); click('Device settings');
  const card = container.querySelector('[aria-label="RFID Region Band"]')!;
  const select = card.querySelector<HTMLSelectElement>('#setting-region')!;
  expect([...select.options].filter(option => option.value).map(option => [option.value, option.textContent])).toEqual([
    ['US', 'US (902-928 MHz)'], ['ETSI', 'ETSI (865-868 MHz)'], ['VN', 'VN (918-923 MHz)'],
  ]);
  expect(select.value).toBe('');
  expect(card.querySelectorAll('input[type="number"]')).toHaveLength(0);
  const apply = [...card.querySelectorAll('button')].find(button => button.textContent === 'Apply')!;
  const save = card.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(apply.disabled).toBe(true); expect(save.disabled).toBe(true);
  props.settings = { ...props.settings, regionBand: parseRegionReading(REGION_REPLIES.ETSI)!, regionBandConfirmed: true, regionBandSupport: 'supported' };
  render(<DashboardLayout {...props} />);
  expect(apply.disabled).toBe(false); expect(save.disabled).toBe(false);
  expect(card.textContent).toContain('865.7, 866.3, 866.9, 867.5 MHz'); expect(card.textContent).toContain('step 600 kHz');
  act(() => { select.value = 'VN'; select.dispatchEvent(new Event('change', { bubbles: true })); save.click(); });
  act(() => apply.click());
  expect(props.onSettingsAction).toHaveBeenLastCalledWith({ id: 'region-band', mode: 'apply', value: { selection: 'VN', save: false } });
  expect(card.querySelector('[aria-label="Current region"]')?.textContent).toContain('ETSI');
  expect(card.textContent).toContain('918.75–922.25 MHz');
});
it.each([SUBSET_REPLY, UNKNOWN_REPLY])('preserves read-only actual Region without selecting US or sending a write: %j', packet => {
  const props = fixture(); props.status = 'connected';
  props.settings = { ...props.settings, regionBand: parseRegionReading(packet)!, regionBandConfirmed: true, regionBandSupport: 'supported' };
  render(<DashboardLayout {...props} />); click('Advanced'); click('Device settings');
  const card = container.querySelector('[aria-label="RFID Region Band"]')!;
  const select = card.querySelector<HTMLSelectElement>('#setting-region')!;
  expect(select.value).toBe(''); expect(card.textContent).toContain('read-only');
  expect(card.textContent).toContain(`band ${packet.band}`);
  expect(props.onSettingsAction).not.toHaveBeenCalled();
  const actual = card.querySelector('[aria-label="Current region"]')!.textContent;
  if (packet.band === 4) expect(actual).not.toContain('MHz');
  act(() => { select.value = 'ETSI'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(card.querySelector('[aria-label="Current region"]')!.textContent).toBe(actual);
  const apply = [...card.querySelectorAll('button')].find(button => button.textContent === 'Apply')!;
  expect(apply.disabled).toBe(false);
});
it('shows unsupported or stale Region state without enabling Apply, and locks all Region controls during scan', () => {
  const props = fixture(); props.status = 'connected';
  props.settings = { ...props.settings, regionBand: parseRegionReading(REGION_REPLIES.VN)!, regionBandConfirmed: false, regionBandSupport: 'unavailable', regionBandError: 'GF: timeout' };
  render(<DashboardLayout {...props} />); click('Advanced'); click('Device settings');
  const card = container.querySelector('[aria-label="RFID Region Band"]')!;
  expect(card.textContent).toContain('Unconfirmed'); expect(card.textContent).toContain('Firmware chưa hỗ trợ cấu hình Region');
  expect(card.textContent).toContain('GF: timeout');
  const read = [...card.querySelectorAll('button')].find(button => button.textContent === 'Read')!;
  const apply = [...card.querySelectorAll('button')].find(button => button.textContent === 'Apply')!;
  expect(read.disabled).toBe(false); expect(apply.disabled).toBe(true);
  props.settings = { ...props.settings, regionBandConfirmed: true, regionBandSupport: 'supported' }; props.isScanning = true;
  render(<DashboardLayout {...props} />);
  expect(read.disabled).toBe(true); expect(apply.disabled).toBe(true);
});

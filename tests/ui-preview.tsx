/// <reference types="vite/client" />
/** Development-only UI fixture. Not an entry point in the production build. No hardware connection. */
import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardLayout } from '../components/dashboard/DashboardLayout';
import { LogEntry, Tag, WriteStatus, Settings } from '../types';
import { useSettingsActions } from '../hooks/useSettingsActions';
import { DeviceCommand, SETTING_META, parseSettingReading, SettingId } from '../utils/settingsProtocol';

const sampleTags: Tag[] = Array.from({ length: 240 }, (_, i) => ({ epc: `E200001122334455${i.toString(16).toUpperCase().padStart(8, '0')}`, count: i + 5, rssi: -60 - i % 25, timestamp: Date.now() }));
const noop = () => {};
function Preview() {
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState<'interactive' | 'batch' | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [locating, setLocating] = useState(false);
  const [writeStatus, setWriteStatus] = useState<WriteStatus>('idle');
  const [commandPending, setCommandPending] = useState(false);
  const [lost, setLost] = useState(false);
  const [writeFails, setWriteFails] = useState(false);
  const attempt = useRef(0);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (writeTimer.current) clearTimeout(writeTimer.current); }, []);
  const [history, setHistory] = useState<{ INDEX: number; EPC: string }[]>([]);
  const [settings, setSettings] = useState<Settings>({ power: 20, buzzer: true, tagFocus: true, fastTid: false, linkProfile: 53, qValue: 4, session: 1, scanParams: { interval: 30, dwell: 2, count: 0 }, version: 'UI-TEST', temperature: 32, batterySnapshot: { voltageMv: 7900, protectionState: 'normal', visualPercent: 73, receivedAtMs: Date.now(), stale: false }, deviceInfo: 'NHR10-TEST', deviceName: 'NHR10-TEST', deviceCanonicalId: 'UI-FIXTURE-ONLY', regionBand: { val: 'US', mode: 'template' } });
  const [settingsError, setSettingsError] = useState(false);
  const [settingsTimeout, setSettingsTimeout] = useState(false);
  const simulatedReadings = useRef<Record<string, any>>({ GP: { val: 20 }, GLP: { val: 53 }, GQS: { q: 4, session: 1 }, GQP: { interval: 30, dwell: 2, times: 0 }, GTF: { val: 1 }, GDN: { val: 'NHR10-TEST' }, GF: { val: 'US', mode: 'template' } });
  const settingsTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => settingsTimers.current.forEach(clearTimeout), []);
  const log = (message: string, type: LogEntry['type'] = 'info', notice?: LogEntry['notice']) => setLogs(current => [...current, { message, type, timestamp: Date.now(), notice }].slice(-1000));
  const sendSimulatedSetting = async (command: DeviceCommand) => {
    log(`TX: ${JSON.stringify(command)}`, 'tx');
    if (settingsTimeout) return;
    settingsTimers.current.push(setTimeout(() => {
      const entry = Object.entries(SETTING_META).find(([, meta]) => meta.get === command.cmd || meta.set === command.cmd);
      const id = entry?.[0] as SettingId | undefined;
      const meta = entry?.[1];
      let response: any = { cmd: command.cmd, status: settingsError ? 'err' : 'ok', ...(settingsError ? { msg: 'Simulated device rejection' } : {}) };
      if (!settingsError && meta) {
        if (command.cmd === meta.set) {
          const parts = String(command.val).split(',').map(Number);
          simulatedReadings.current[meta.get] = id === 'q-session' ? { q: parts[0], session: parts[1] } : id === 'query-params' ? { interval: parts[0], dwell: parts[1], times: parts[2] } : id === 'region-band' ? { ...command, mode: command.mode ?? 'template' } : { val: command.val };
          if (id === 'profile') response = { cmd: 'GLP', ...simulatedReadings.current.GLP };
        } else response = { ...simulatedReadings.current[meta.get], cmd: meta.get };
      }
      settingActions.handleDataReceived(response);
      if (id) {
        const reading = parseSettingReading(id, response);
        if (reading) setSettings(current => ({ ...current,
          ...(id === 'power' ? { power: Number(reading.val) } : id === 'profile' ? { linkProfile: Number(reading.val) } : id === 'tag-focus' ? { tagFocus: reading.val === 1 } : id === 'q-session' ? { qValue: Number(reading.q), session: Number(reading.session) } : id === 'query-params' ? { scanParams: { interval: Number(reading.interval), dwell: Number(reading.dwell), append: Number(reading.append), count: Number(reading.append) } } : id === 'device-name' ? { deviceName: String(reading.val) } : { regionBand: { val: String(reading.val ?? 'CUSTOM'), mode: response.mode, startKHz: Number(reading.startKHz), count: Number(reading.count), space125KHz: Number(reading.space125KHz) } }),
        }));
      }
      log(`RX: ${JSON.stringify(response)}`, 'rx');
    }, 1100));
  };
  const settingActions = useSettingsActions(log, connected ? 'connected' : 'disconnected', sendSimulatedSetting);
  const write = () => {
    setWriteStatus('pending');
    const id = `write-${++attempt.current}`;
    writeTimer.current = setTimeout(() => {
      setWriteStatus(writeFails ? 'error' : 'success');
      log(writeFails ? 'Simulated write failed (tag not in range). Scan the tag before retrying.' : 'The reader confirmed the write. Scan the tag again to verify its data.', writeFails ? 'error' : 'info', { id, title: writeFails ? 'Write needs attention' : 'Write confirmed' });
    }, 2000);
  };
  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(() => log('GB: simulated battery telemetry', 'rx'), 100);
    return () => window.clearInterval(timer);
  }, [connected]);
  const props: React.ComponentProps<typeof DashboardLayout> = {
    status: connected ? 'connected' : 'disconnected', commandPending,
    settings, settingsActivity: settingActions.activity, onSettingsAction: settingActions.run,
    tags, logs, scanStats: { visibleTags: tags.length, totalReads: tags.length * 5, readsPerSecond: mode ? 238 : 0, uniquePerSecond: 0, averageRssi: -67, peakRssi: -60 },
    isScanning: mode !== null, scanStartedAt: null, scanStoppedAt: null, removeStaleTags: false, staleRemoveMs: 3000,
    onChangeRemoveStaleTags: noop, onChangeStaleRemoveMs: noop,
    onConnect: () => { setConnected(true); log('Connected to NHR10-TEST'); }, onDisconnect: () => { setConnected(false); setMode(null); setLocating(false); },
    activeScanType: mode, onStartScan: () => { setMode('interactive'); setTags(sampleTags); }, onStopScan: () => setMode(null), onStartBatch: () => setMode('batch'), onStopBatch: () => setMode(null), onClearTags: () => setTags([]),
    onLocate: () => setLocating(true), onStopLocate: () => setLocating(false), targetRssi: locating && !lost ? -63 : null, isLocating: locating, locateSignalState: locating ? lost ? 'lost' : 'detected' : 'idle',
    onWriteEpc: write, onWriteData: write, writeStatus, writeMessage: '',
    onUpdateSettings: noop, onSaveSetting: noop, onFetchHistory: () => setHistory(sampleTags.map((tag, i) => ({ INDEX: i + 1, EPC: tag.epc }))), onDownloadJson: noop, onDownloadCsv: noop, onDownloadTxt: noop, onShare: noop, onClearFileData: () => setHistory([]), historyData: history,
    isBatchSaving: false, batchSaveInfo: { state: 'idle', progress: 0, written: 0, total: 0 }, onDownloadLogs: noop, onClearLogs: () => setLogs([]), isFileTransferring: false, transferProgress: 0, transferStatus: 'idle', onApplyPreset: noop, onShowPopup: () => log('Popup sent: UI fixture'),
  };
  return <><div style={{ height: 110, padding: '8px 16px', background: '#fffbeb', color: '#92400e', fontSize: 12 }}><p>UI test fixture · Simulated data · No Bluetooth connection</p><div className="mt-1 flex gap-4"><button onClick={() => setCommandPending(!commandPending)} aria-pressed={commandPending}>Command wait</button><button onClick={() => setLost(!lost)} aria-pressed={lost}>Tag lost</button><button onClick={() => setWriteFails(!writeFails)} aria-pressed={writeFails}>Write failure</button></div><div className="mt-2 flex gap-4"><button onClick={() => setSettingsError(!settingsError)} aria-pressed={settingsError}>Settings error</button><button onClick={() => setSettingsTimeout(!settingsTimeout)} aria-pressed={settingsTimeout}>Settings timeout</button></div></div><DashboardLayout {...props} /></>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());

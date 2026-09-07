import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useNotifications } from '../../hooks/useNotifications';
import { SettingsActivity } from '../../hooks/useSettingsActions';
import { SettingsRequest } from '../../utils/settingsProtocol';
import { Notification } from '../ui/Notification';
import { Button } from '../ui/Button';
import { TopBar } from './TopBar';
import { ScannerTab } from './ScannerTab';
import { LocateTab } from './LocateTab';
import { OperationsTab } from './OperationsTab';
import { SettingsTab } from './SettingsTab';
import { DebugTab } from './DebugTab';
import { HistoryTab } from './HistoryTab';
import { BatchSaveInfo, Settings, ConnectionStatus, Tag, LogEntry, ScanStats, FileTransferStatus, LocateSignalState } from '../../types';

interface DashboardLayoutProps {
  status: ConnectionStatus;
  settings: Settings;
  tags: Tag[];
  scanStats: ScanStats;
  logs: LogEntry[];
  commandPending: boolean;
  settingsActivity: SettingsActivity | null;
  onSettingsAction: (request: SettingsRequest) => void | Promise<void>;
  isScanning: boolean;
  scanStartedAt: number | null;
  scanStoppedAt: number | null;
  removeStaleTags: boolean;
  staleRemoveMs: number;
  onChangeRemoveStaleTags: (enabled: boolean) => void;
  onChangeStaleRemoveMs: (value: number) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  activeScanType: 'interactive' | 'batch' | null;
  onStartScan: () => void;
  onStopScan: () => void;
  onStartBatch: () => void;
  onStopBatch: () => void;
  onClearTags: () => void;
  onLocate: (epc: string) => void;
  onStopLocate: () => void;
  targetRssi: number | null;
  locateSignalState: LocateSignalState;
  isLocating: boolean;
  onWriteEpc: (targetEpc: string, newEpc: string, password?: string) => void;
  onWriteData: (epc: string, mem: number, ptr: number, data: string, password?: string) => void;
  writeStatus: 'idle' | 'pending' | 'success' | 'error';
  writeMessage: string;
  onUpdateSettings: (key: keyof Settings, value: any) => void;
  onSaveSetting: (key: string, value: any) => void;
  onFetchHistory: () => void;
  onDownloadJson: () => void;
  onDownloadCsv: () => void;
  onDownloadTxt: () => void;
  onShare: () => void;
  onClearFileData: () => void;
  historyData: any[];
  isBatchSaving: boolean;
  batchSaveInfo: BatchSaveInfo;
  onDownloadLogs: () => void;
  onClearLogs: () => void;
  isFileTransferring: boolean;
  transferProgress: number;
  transferStatus: FileTransferStatus;
  onApplyPreset: (mode: 'standard' | 'quick' | 'deep') => void;
  onShowPopup: (content: string, time: number, beep: boolean) => void;
}

export const DashboardLayout: React.FC<DashboardLayoutProps> = (props) => {
  const [activeTab, setActiveTab] = useState<number>(1);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const { notice, dismiss } = useNotifications(props.logs);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [locateEpc, setLocateEpc] = useState<string>('');
  const [scannerExcludedEpcs, setScannerExcludedEpcs] = useState<string[]>([]);
  const [scannerExcludedSnapshots, setScannerExcludedSnapshots] = useState<Record<string, Tag>>({});

  const tabs = [
    { id: 1, label: 'Scan tags', detail: 'Live inventory' },
    { id: 2, label: 'Find a tag', detail: 'Signal-guided search' },
    { id: 3, label: 'Write EPC', detail: 'Program a tag' },
    { id: 6, label: 'Saved data', detail: 'Batch inventory & export' },
  ];
  const moreTabs = [{ id: 4, label: 'Device settings' }, { id: 5, label: 'Diagnostics' }];
  const isMoreTabActive = moreTabs.some(tab => tab.id === activeTab);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { mainRef.current?.focus({ preventScroll: true }); }, [activeTab]);
  const deviceBusy = props.commandPending || props.writeStatus === 'pending' || props.settingsActivity !== null;
  const operationActive = props.isScanning || props.isLocating || props.isBatchSaving || deviceBusy;
  const operationLabel = props.settingsActivity ? `${props.settingsActivity.phase} ${props.settingsActivity.title}…` : props.commandPending ? 'Waiting for device command…' : props.writeStatus === 'pending' ? 'Waiting for write confirmation…' : props.isBatchSaving ? 'Saving batch data on device…' : props.isFileTransferring ? 'Downloading saved data…' : props.isLocating ? 'Finding a tag' : props.isScanning ? (props.activeScanType === 'batch' ? 'Batch scan in progress' : 'Live scan in progress') : props.status === 'connected' ? 'Device ready' : props.status === 'connecting' ? 'Connecting to the reader…' : 'Connect your reader to begin';
  const showStop = (props.isLocating && activeTab !== 2) || (props.isScanning && activeTab !== 1);

  const selectTab = (tabId: number) => {
    setActiveTab(tabId);
    setMobileMoreOpen(false);
  };

  return (
    <div className="app-space flex flex-col h-[100dvh] overflow-hidden text-[#1D1D1F]">
      {/* Top Bar */}
      <TopBar 
        status={props.status} 
        settings={props.settings} 
        onConnect={props.onConnect} 
        onDisconnect={props.onDisconnect} 
      />

      <div className="flex flex-1 flex-col lg:flex-row overflow-hidden relative min-h-0">
        <a href="#main-content" className="skip-link">Skip to controls</a>
        <aside className="relative z-20 order-2 shrink-0 border-t border-slate-200 bg-white lg:order-1 lg:flex lg:w-[218px] lg:flex-col lg:border-r lg:border-t-0">
          <div className="hidden px-6 pb-3 pt-7 lg:block"><p className="eyebrow">Workspace</p></div>
          <nav aria-label="Main navigation" className="flex justify-around px-1 py-1 lg:block lg:space-y-1 lg:px-3 lg:py-0" style={{ paddingBottom: 'max(4px, env(safe-area-inset-bottom))' }}>
            {tabs.map((tab, index) => (
              <button key={tab.id} onClick={() => selectTab(tab.id)} aria-current={activeTab === tab.id ? 'page' : undefined} className="nav-item !w-auto !flex-1 !justify-center !px-2 !text-[13px] lg:!w-full lg:!justify-start lg:!px-3 lg:!text-sm">
                <span className="nav-number hidden lg:block">0{index + 1}</span><span>{tab.label}</span>
              </button>
            ))}
            <button className="nav-item !w-auto !flex-1 !justify-center !px-2 !text-[13px] lg:!hidden" onClick={() => setMobileMoreOpen(!mobileMoreOpen)} aria-expanded={mobileMoreOpen} aria-controls="mobile-tools" aria-current={isMoreTabActive ? 'page' : undefined}>More</button>
          </nav>
          {mobileMoreOpen && <nav id="mobile-tools" aria-label="Engineering tools" className="absolute bottom-full right-3 mb-2 w-56 rounded-xl border border-slate-200 bg-white p-2 shadow-lg lg:hidden">
            <p className="eyebrow px-3 py-2">Advanced</p>
            {moreTabs.map(tab => <button key={tab.id} className="nav-item" aria-current={activeTab === tab.id ? 'page' : undefined} onClick={() => selectTab(tab.id)}>{tab.label}</button>)}
          </nav>}
          <div className="mt-8 hidden border-t border-slate-100 px-3 pt-4 lg:block">
            <button className="nav-item justify-between" onClick={() => setAdvancedOpen(!advancedOpen)} aria-expanded={advancedOpen || isMoreTabActive} aria-controls="advanced-navigation">Advanced<ChevronDown size={15} className={advancedOpen || isMoreTabActive ? 'rotate-180' : ''} /></button>
            {(advancedOpen || isMoreTabActive) && <nav id="advanced-navigation" aria-label="Engineering tools">
              {moreTabs.map(tab => <button key={tab.id} className="nav-item pl-6" aria-current={activeTab === tab.id ? 'page' : undefined} onClick={() => selectTab(tab.id)}>{tab.label}</button>)}
              <p className="px-3 py-2 text-xs leading-5 text-slate-400">RF configuration and service diagnostics.</p>
            </nav>}
          </div>
          <div className="mt-auto hidden px-6 py-6 lg:block"><p className="text-xs font-medium text-slate-500">Nextwaves NHR-10</p><p className="mt-1 text-xs text-slate-400">{props.status === 'connected' && props.settings.version ? 'Firmware ' + props.settings.version : 'Bluetooth controller'}</p></div>
        </aside>
        <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col lg:order-2">
          <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 text-xs text-slate-500 sm:px-6 sm:text-sm" aria-label="Device activity">
            <span role="status" className={`min-w-0 line-clamp-2 ${operationActive || props.isFileTransferring ? 'text-blue-700' : ''}`}>{operationLabel}</span>
            <Button className={`w-[112px] shrink-0 !px-2 ${showStop ? '' : 'invisible'}`} variant="outline" size="sm" disabled={!showStop || props.isBatchSaving || deviceBusy} tabIndex={showStop ? 0 : -1} aria-hidden={!showStop} onClick={props.isLocating ? props.onStopLocate : props.activeScanType === 'batch' ? props.onStopBatch : props.onStopScan}>Stop {props.isLocating ? 'finding' : 'scan'}</Button>
          </div>
          <main id="main-content" ref={mainRef} tabIndex={-1} className="relative min-h-0 min-w-0 flex-1 overflow-hidden outline-none">
          {activeTab === 1 && (
            <ScannerTab 
              isScanning={props.isScanning}
              activeScanType={props.activeScanType}
              scanStartedAt={props.scanStartedAt}
              scanStoppedAt={props.scanStoppedAt}
              removeStaleTags={props.removeStaleTags}
              staleRemoveMs={props.staleRemoveMs}
              onChangeRemoveStaleTags={props.onChangeRemoveStaleTags}
              onChangeStaleRemoveMs={props.onChangeStaleRemoveMs}
              onStartScan={props.onStartScan}
              onStopScan={props.onStopScan}
              onStartBatch={props.onStartBatch}
              onStopBatch={props.onStopBatch}
              onClear={props.onClearTags}
              tags={props.tags}
              stats={props.scanStats}
              onApplyPreset={props.onApplyPreset}
              onChooseTag={(epc) => { setLocateEpc(epc); selectTab(2); }}
              onOpenStorage={() => selectTab(6)}
              isBusy={props.isLocating || props.isFileTransferring || deviceBusy}
              isConnecting={props.status === 'connecting'}
              isBatchSaving={props.isBatchSaving}
              isConnected={props.status === 'connected'}
              onConnect={props.onConnect}
              batchSaveInfo={props.batchSaveInfo}
              excludedEpcs={scannerExcludedEpcs}
              excludedSnapshots={scannerExcludedSnapshots}
              setExcludedEpcs={setScannerExcludedEpcs}
              setExcludedSnapshots={setScannerExcludedSnapshots}
            />
          )}
          
          {activeTab === 2 && (
            <LocateTab 
              onLocate={props.onLocate}
              onStopLocate={props.onStopLocate}
              isBusy={props.isScanning || props.isBatchSaving || props.isFileTransferring || deviceBusy}
              tags={props.tags}
              targetRssi={props.targetRssi}
              signalState={props.locateSignalState}
              isLocating={props.isLocating}
              targetEpc={locateEpc}
              setTargetEpc={setLocateEpc}
              isConnected={props.status === 'connected'}
            />
          )}

          {activeTab === 3 && (
            <OperationsTab 
              tags={props.tags}
              isBusy={operationActive || props.isFileTransferring}
              onWriteEpc={props.onWriteEpc}
              onWriteData={props.onWriteData}
              writeStatus={props.writeStatus}
              isConnected={props.status === 'connected'}
            />
          )}

          {activeTab === 6 && (
            <HistoryTab 
              isBusy={props.isScanning || props.isLocating || deviceBusy}
              onFetchHistory={props.onFetchHistory}
              onDownloadJson={props.onDownloadJson}
              onDownloadCsv={props.onDownloadCsv}
              onDownloadTxt={props.onDownloadTxt}
              onShare={props.onShare}
              onClearFileData={props.onClearFileData}
              historyData={props.historyData}
              isFileTransferring={props.isFileTransferring}
              transferProgress={props.transferProgress}
              transferStatus={props.transferStatus}
              isBatchSaving={props.isBatchSaving}
              batchSaveInfo={props.batchSaveInfo}
              isConnected={props.status === 'connected'}
              onConnect={props.onConnect}
            />
          )}

          {activeTab === 4 && (
            <SettingsTab 
              isBusy={props.isScanning || props.isLocating || props.isBatchSaving || props.commandPending || props.writeStatus === 'pending' || props.isFileTransferring}
              activity={props.settingsActivity}
              onAction={props.onSettingsAction}
              settings={props.settings}
              isConnected={props.status === 'connected'}
            />
          )}

          {activeTab === 5 && (
            <DebugTab 
              settings={props.settings}
              status={props.status}
              onConnect={props.onConnect}
              onShowPopup={props.onShowPopup}
              isBusy={operationActive || props.isFileTransferring}
              logs={props.logs}
              onDownloadHistory={props.onDownloadLogs}
              onClearLogs={props.onClearLogs}
              isFileTransferring={props.isFileTransferring}
              transferProgress={props.transferProgress}
            />
          )}
          </main>
        </div>
        <Notification notice={notice} onDismiss={dismiss} />
      </div>
    </div>
  );
};

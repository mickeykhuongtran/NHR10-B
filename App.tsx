import React, { useState, useEffect, useCallback, useRef } from 'react';
import { bleService } from './services/bleService';
import { DashboardLayout } from './components/dashboard/DashboardLayout';
import { BatchSaveInfo, WriteStatus } from './types';
import { useRFIDConnection } from './hooks/useRFIDConnection';
import { useScanLogic } from './hooks/useScanLogic';
import { useLocateLogic } from './hooks/useLocateLogic';
import { useFileTransfer } from './hooks/useFileTransfer';
import { useSettingsActions } from './hooks/useSettingsActions';
import { SettingsRequest } from './utils/settingsProtocol';
import { parseProfileFormat, presetProfileId } from './utils/rfLinkProfile';

const DEFAULT_BATCH_SAVE_INFO: BatchSaveInfo = {
  state: 'idle',
  progress: 0,
  written: 0,
  total: 0,
};

const toSafeNumber = (value: unknown, fallback = 0): number => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
};

const clampProgress = (value: unknown): number => Math.max(0, Math.min(100, toSafeNumber(value)));

const App: React.FC = () => {
  // --- Hooks ---
  const connection = useRFIDConnection();
  const scan = useScanLogic(connection.addLog);
  const locate = useLocateLogic(connection.addLog);
  const fileTransfer = useFileTransfer(connection.addLog);

  // --- Operation State (Write) ---
  const [writeStatus, setWriteStatus] = useState<WriteStatus>('idle');
  const [writeMessage, setWriteMessage] = useState('');
  const writeAttemptRef = useRef(0);
  const pendingWriteRef = useRef<number | null>(null);
  const [commandPending, setCommandPending] = useState(false);
  const commandPendingRef = useRef(false);
  const [batchSaveInfo, setBatchSaveInfo] = useState<BatchSaveInfo>(DEFAULT_BATCH_SAVE_INFO);
  const batchSavingTimerRef = useRef<number | null>(null);
  const isBatchSaving = batchSaveInfo.state === 'saving';
  const settingsActions = useSettingsActions(connection.addLog, connection.status, undefined, connection.invalidateProfile, connection.updateRegionStatus);

  const runOperation = async (action: () => Promise<void>) => {
    if (commandPendingRef.current || pendingWriteRef.current !== null || settingsActions.isPending() || connection.status !== 'connected') return;
    commandPendingRef.current = true;
    setCommandPending(true);
    try { await action(); } finally {
      commandPendingRef.current = false;
      setCommandPending(false);
    }
  };

  const finishWrite = useCallback((status: 'success' | 'error', message: string) => {
    const attempt = pendingWriteRef.current;
    if (attempt === null) return;
    pendingWriteRef.current = null;
    setWriteStatus(status);
    setWriteMessage(message);
    connection.addLog(message, status === 'success' ? 'info' : 'error', {
      id: `write-${attempt}`,
      title: status === 'success' ? 'Write confirmed' : 'Write needs attention',
    });
  }, [connection.addLog]);

  useEffect(() => {
    if (writeStatus !== 'pending') return;
    const timer = window.setTimeout(() => {
      finishWrite('error', 'No write response received. Scan the tag to verify its data before retrying.');
    }, 10000);
    return () => window.clearTimeout(timer);
  }, [writeStatus, finishWrite]);

  useEffect(() => {
    if (connection.status !== 'connected' && connection.status !== 'connecting' && writeStatus === 'pending') {
      finishWrite('error', 'Connection lost before write confirmation. Scan the tag to verify its data before retrying.');
    }
  }, [connection.status, writeStatus, finishWrite]);

  const clearBatchSavingTimer = useCallback(() => {
    if (batchSavingTimerRef.current !== null) {
      window.clearTimeout(batchSavingTimerRef.current);
      batchSavingTimerRef.current = null;
    }
  }, []);

  const markBatchSaving = useCallback((next?: Partial<BatchSaveInfo>, useFallbackTimer = true) => {
    clearBatchSavingTimer();
    setBatchSaveInfo((current) => ({
      state: 'saving',
      progress: clampProgress(next?.progress ?? current.progress ?? 0),
      written: Math.max(0, toSafeNumber(next?.written ?? current.written ?? 0)),
      total: Math.max(0, toSafeNumber(next?.total ?? current.total ?? 0)),
    }));

    if (useFallbackTimer) {
      batchSavingTimerRef.current = window.setTimeout(() => {
        setBatchSaveInfo((current) => current.state === 'saving' ? DEFAULT_BATCH_SAVE_INFO : current);
        batchSavingTimerRef.current = null;
      }, 3000);
    }
  }, [clearBatchSavingTimer]);

  const clearBatchSaving = useCallback((next?: Partial<BatchSaveInfo>) => {
    clearBatchSavingTimer();
    setBatchSaveInfo({
      state: next?.state ?? 'idle',
      progress: clampProgress(next?.progress ?? 0),
      written: Math.max(0, toSafeNumber(next?.written ?? 0)),
      total: Math.max(0, toSafeNumber(next?.total ?? 0)),
    });
  }, [clearBatchSavingTimer]);

  // --- Unified Data Handler ---
const handleDataReceived = useCallback((data: any) => {
    const handledSettingsReply = settingsActions.handleDataReceived(data);
    // 1. Dữ liệu hệ thống (Pin, Info, Settings) luôn được cho phép xử lý
    connection.handleDataReceived(data);

    // 2. GUARD BẢO VỆ INTERACTIVE/BATCH MODE: 
    // Chỉ truyền gói live_tags xuống khi isScanning đang là true
    if (data.cmd === 'live_tags') {
      if (scan.isScanning) {
        scan.handleDataReceived(data);
      }
    } else {
      // Các gói khác (nếu có) mà scan hook cần xử lý
      scan.handleDataReceived(data);
    }

    // The locate hook guards the active session and target synchronously,
    // including a response arriving before React renders the new state.
    locate.handleDataReceived(data);

    // 4. Write Responses
    if (data.cmd === 'WE' || data.cmd === 'WD') {
        if (data.status === 'ok') {
            finishWrite('success', 'The reader confirmed the write. Scan the tag again to verify its data.');
        } else {
            finishWrite('error', `Write failed (${data.code ?? data.msg ?? 'unknown error'}). Check the target tag and scan its data before retrying.`);
        }
    }

    if (data.cmd === 'SAVE' && data.mode === 'batch') {
      const saveState = String(data.state ?? '').toLowerCase();
      const nextSaveInfo = {
        progress: clampProgress(data.progress ?? 0),
        written: Math.max(0, toSafeNumber(data.written ?? 0)),
        total: Math.max(0, toSafeNumber(data.total ?? 0)),
      };

      if (saveState === 'saving') {
        markBatchSaving(nextSaveInfo, false);
      } else if (saveState === 'saved') {
        clearBatchSaving({ state: 'saved', progress: 100, written: nextSaveInfo.written, total: nextSaveInfo.total });
        connection.addLog('Batch file saved on device', 'info');
      } else if (saveState === 'save_failed') {
        clearBatchSaving({ state: 'save_failed', ...nextSaveInfo });
        connection.addLog(`Batch file save failed at ${nextSaveInfo.progress}%`, 'error');
      }
    } else if (data.cmd === 'XB') {
      const state = String(data.state ?? data.status ?? data.val ?? '').toLowerCase();
      if (state.includes('saving') || state.includes('busy')) {
        markBatchSaving();
      } else if (
        data.status === 'ok' ||
        state.includes('saved') ||
        state.includes('done') ||
        state.includes('stopped') ||
        state.includes('idle')
      ) {
        clearBatchSaving();
      }
    }

    if (['GF', 'SF'].includes(data.cmd) && data.status === 'err' && !handledSettingsReply) {
      connection.addLog(`Region response: ${data.error ?? data.msg ?? data.code ?? 'unknown_error'}`, 'error');
    }
  }, [connection, scan, locate, markBatchSaving, clearBatchSaving, finishWrite, settingsActions.handleDataReceived]);

  useEffect(() => {
    if (fileTransfer.transferStatus === 'saving') {
      markBatchSaving(undefined, false);
    } else if (fileTransfer.transferStatus === 'transferring' || fileTransfer.transferStatus === 'complete') {
      clearBatchSaving();
    }
  }, [clearBatchSaving, fileTransfer.transferStatus, markBatchSaving]);

  useEffect(() => () => clearBatchSavingTimer(), [clearBatchSavingTimer]);

  // --- Setup Service ---
  useEffect(() => {
    bleService.setCallbacks(
      handleDataReceived, 
      (msg, type) => connection.addLog(msg, type), 
      fileTransfer.handleFileCallback,
      connection.handleConnectionStatusChange,
    );
  }, [handleDataReceived, connection.addLog, connection.handleConnectionStatusChange, fileTransfer.handleFileCallback]);

  useEffect(() => {
    if (connection.status !== 'disconnected' && connection.status !== 'error') return;

    scan.resetScanSession();
    locate.resetLocateState();
    clearBatchSaving();
  }, [clearBatchSaving, connection.status, locate.resetLocateState, scan.resetScanSession]);

  useEffect(() => {
    const connectionMode = isBatchSaving
      ? 'batchSaving'
      : scan.activeScanType === 'batch'
        ? 'batch'
        : scan.activeScanType === 'interactive'
          ? 'interactive'
          : locate.isLocating
            ? 'locate'
            : 'idle';

    connection.setInventoryActive(connection.status === 'connected' && connectionMode !== 'idle', connectionMode);
  }, [connection.setInventoryActive, connection.status, isBatchSaving, locate.isLocating, scan.activeScanType]);

  const synchronizedRevision = useRef(0);
  const refreshSettings = useCallback(async () => {
    await settingsActions.runSequence([
      { id: 'profile', mode: 'read' },
      { id: 'device-name', mode: 'read' },
      { id: 'power', mode: 'read' },
      { id: 'q-session', mode: 'read' },
      { id: 'query-params', mode: 'read' },
      { id: 'tag-focus', mode: 'read' },
      { id: 'region-band', mode: 'read' },
    ], { silent: true, continueOnReadError: true });
  }, [settingsActions.runSequence]);
  useEffect(() => {
    if (connection.status !== 'connected' || !connection.connectionRevision || synchronizedRevision.current === connection.connectionRevision || settingsActions.isPending()) return;
    synchronizedRevision.current = connection.connectionRevision;
    void refreshSettings();
  }, [connection.status, connection.connectionRevision, refreshSettings, settingsActions.activity, settingsActions.isPending]);

  const handleRefreshSettings = async () => {
    await runOperation(async () => {
      await refreshSettings();
      await bleService.getInfo();
      await bleService.getBattery();
      await bleService.getTemperature();
    });
  };

  // --- Handlers ---

  const handleSettingsAction = useCallback((request: SettingsRequest) => {
    if (commandPendingRef.current || pendingWriteRef.current !== null || scan.isScanning || locate.isLocating || isBatchSaving || fileTransfer.isFileTransferring) return;
    return settingsActions.run(request).then(() => undefined);
  }, [scan.isScanning, locate.isLocating, isBatchSaving, fileTransfer.isFileTransferring, settingsActions.run]);

  const handleApplyPreset = async (mode: 'standard' | 'quick' | 'deep') => {
    if (scan.isScanning || locate.isLocating || isBatchSaving || fileTransfer.isFileTransferring) throw new Error('Stop the current operation before applying a preset.');
    if (!connection.settings.linkProfileConfirmed) throw new Error('RF profile is unconfirmed. Read it from the device first.');
    const profile = presetProfileId(mode, parseProfileFormat(connection.settings.linkProfileFormat));
    let applied = false;
    await runOperation(async () => {
      applied = await settingsActions.runSequence([
        { id: 'baseband', mode: 'apply', value: { profile, q: mode === 'quick' ? 2 : 4, session: mode === 'quick' ? 0 : 1, target: 0 } },
        { id: 'tag-focus', mode: 'apply', value: mode !== 'quick' },
      ]);
    });
    if (!applied) throw new Error('Preset was not fully confirmed. Read the current settings before retrying.');
  };

  const writeTag = async (action: () => Promise<void>) => {
    if (pendingWriteRef.current !== null || commandPendingRef.current || settingsActions.isPending() || connection.status !== 'connected' || scan.isScanning || locate.isLocating || isBatchSaving || fileTransfer.isFileTransferring) return;
    const attempt = ++writeAttemptRef.current;
    pendingWriteRef.current = attempt;
    setWriteStatus('pending');
    setWriteMessage('');
    try {
      await action();
    } catch (e: any) {
      if (pendingWriteRef.current === attempt) finishWrite('error', `Write command failed: ${e.message}. Scan the tag to verify its data before retrying.`);
    }
  };

  const handleWriteEpc = (targetEpc: string, newEpc: string, password?: string) =>
    writeTag(() => bleService.writeEpc(targetEpc, newEpc, password));

  const handleWriteData = (epc: string, mem: number, ptr: number, data: string, password?: string) =>
    writeTag(() => bleService.writeData(epc, mem, ptr, data, password));

  const handleDownloadLogs = () => {
    try {
      const report = {
        format: 'nhr10-service-report',
        version: 1,
        exportedAt: new Date().toISOString(),
        connectionStatus: connection.status,
        device: connection.settings,
        operation: { scanType: scan.activeScanType, locating: locate.isLocating, batchSave: batchSaveInfo },
        environment: { userAgent: navigator.userAgent, secureContext: window.isSecureContext, webBluetooth: 'bluetooth' in navigator },
        logs: connection.logs,
      };
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nhr10_service_report_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to download logs', e);
    }
  };

  const handleShowPopup = async (content: string, time: number, beep: boolean) => {
    try {
      await bleService.showPopup(content, time, beep);
      connection.addLog(`Popup sent: ${content}`, 'info');
    } catch (e: any) {
      connection.addLog(`Popup failed: ${e.message}`, 'error');
    }
  };

  return (
    <DashboardLayout
      status={connection.status}
      settings={connection.settings}
      tags={scan.tags}
      scanStats={scan.stats}
      logs={connection.logs}
      commandPending={commandPending}
      settingsActivity={settingsActions.activity}
      onSettingsAction={handleSettingsAction}
      
      onConnect={connection.connect}
      onDisconnect={() => {
        connection.disconnect();
        scan.resetScanSession();
        locate.resetLocateState();
      }}
      
      isScanning={scan.isScanning}
      activeScanType={scan.activeScanType}
      scanStartedAt={scan.scanStartedAt}
      scanStoppedAt={scan.scanStoppedAt}
      removeStaleTags={scan.removeStaleTags}
      staleRemoveMs={scan.staleRemoveMs}
      onChangeRemoveStaleTags={scan.setRemoveStaleTags}
      onChangeStaleRemoveMs={scan.setStaleRemoveMs}
      onStartScan={() => runOperation(scan.startScan)}
      onStopScan={() => runOperation(async () => {
        await scan.stopScan();
        locate.resetLocateState();
      })}
      onStartBatch={() => runOperation(scan.startBatch)}
      onStopBatch={() => runOperation(async () => {
        markBatchSaving();
        await scan.stopScan();
        locate.resetLocateState();
      })}
      onClearTags={scan.clearTags}
      
      onLocate={(epc) => runOperation(() => locate.startLocate(epc))}
      onStopLocate={() => runOperation(locate.stopLocate)}
      targetRssi={locate.targetRssi}
      locateSignalState={locate.signalState}
      isLocating={locate.isLocating}
      
      onWriteEpc={handleWriteEpc}
      onWriteData={handleWriteData}
      writeStatus={writeStatus}
      writeMessage={writeMessage}
      
      onRefreshSettings={handleRefreshSettings}
      onApplyPreset={handleApplyPreset}
      onShowPopup={handleShowPopup}
      
      onDownloadLogs={handleDownloadLogs}
      onFetchHistory={() => {
        if (isBatchSaving) {
          connection.addLog('Batch data is still saving on device. Fetch is temporarily disabled.', 'info');
          return;
        }
        fileTransfer.fetchHistory();
      }}
      onDownloadJson={fileTransfer.downloadJson}
      onDownloadCsv={fileTransfer.downloadCsv}
      onDownloadTxt={fileTransfer.downloadTxt}
      onShare={fileTransfer.shareFile}
      onClearFileData={fileTransfer.clearFileData}
      historyData={fileTransfer.historyData}
      isBatchSaving={isBatchSaving}
      batchSaveInfo={batchSaveInfo}
      
      onClearLogs={connection.clearLogs}
      isFileTransferring={fileTransfer.isFileTransferring}
      transferProgress={fileTransfer.transferProgress}
      transferStatus={fileTransfer.transferStatus}
    />
  );
};

export default App;

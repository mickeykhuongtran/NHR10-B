import React, { useState, useEffect, useCallback, useRef } from 'react';
import { bleService } from './services/bleService';
import { DashboardLayout } from './components/dashboard/DashboardLayout';
import { BatchSaveInfo, Settings, WriteStatus } from './types';
import { useRFIDConnection } from './hooks/useRFIDConnection';
import { useScanLogic } from './hooks/useScanLogic';
import { useLocateLogic } from './hooks/useLocateLogic';
import { useFileTransfer } from './hooks/useFileTransfer';
import { useSettingsActions } from './hooks/useSettingsActions';
import { SettingsRequest } from './utils/settingsProtocol';

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
  const settingsActions = useSettingsActions(connection.addLog, connection.status);

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

    if (data.cmd === 'SF' && !handledSettingsReply) {
      if (data.status === 'ok') {
        connection.addLog(`Region Band set: ${data.val ?? data.mode ?? 'updated'}`, 'info');
        void bleService.getRegion().catch((error) => connection.addLog(`Region sync failed: ${error.message}`, 'error'));
      } else if (data.status === 'err') {
        connection.addLog(`Region Band set failed: ${data.msg ?? data.code ?? 'unknown_error'}`, 'error');
      }
    }

    if (data.cmd === 'GF' && data.status === 'err' && !handledSettingsReply) {
      connection.addLog(`Region Band read failed: ${data.msg ?? data.code ?? 'unknown_error'}`, 'error');
    }

    if (data.cmd === 'SDN' && !handledSettingsReply) {
      const status = String(data.status ?? '').toLowerCase();
      if (status === 'err' || status === 'error' || data.ok === false) {
        connection.addLog(`Bluetooth name update failed: ${data.msg ?? data.code ?? 'unknown_error'}`, 'error');
      } else {
        connection.addLog('Bluetooth name saved; disconnect to publish it in the next advertising cycle', 'info');
        // Re-read the persisted value instead of trusting an optimistic UI update.
        void bleService.getConfiguredDeviceName().catch((error) => connection.addLog(`Device name sync failed: ${error.message}`, 'error'));
      }
    }

    if (data.cmd === 'GDN' && !handledSettingsReply) {
      const status = String(data.status ?? '').toLowerCase();
      if (status === 'err' || status === 'error' || data.ok === false) {
        connection.addLog(`Bluetooth name read failed: ${data.msg ?? data.code ?? 'unknown_error'}`, 'error');
      }
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

  // --- Handlers ---

  const handleUpdateSettings = async (key: keyof Settings, value: any) => {
    try {
      if (key === 'power') {
        await bleService.setPower(value);
        connection.setSettings(s => ({ ...s, power: value }));
      } else if (key === 'buzzer') {
        await bleService.sendCommand({ cmd: 'BZ', val: value ? 'on' : 'off' });
        connection.setSettings(s => ({ ...s, buzzer: value }));
      } else if (key === 'tagFocus') {
        await bleService.setTagFocus(value);
        connection.setSettings(s => ({ ...s, tagFocus: value }));
      } else if (key === 'fastTid') {
        await bleService.sendCommand({ cmd: 'TID', val: value ? 1 : 0 });
        connection.setSettings(s => ({ ...s, fastTid: value }));
      } else if (key === 'linkProfile') {
        const profile = Number(value);
        await bleService.setLinkProfile(profile);
        connection.setSettings(s => ({ ...s, linkProfile: profile }));
      } else if (key === 'qValue') {
        const { q, s } = value;
        await bleService.setBaseband(connection.settings.linkProfile, q, s);
        connection.setSettings(prev => ({ ...prev, qValue: q, session: s }));
      } else if (key === 'scanParams') {
        const { interval, dwell, count, append } = value;
        // V12.6: Send values directly, firmware handles conversion
        // interval: ms value (firmware divides by 10)
        // dwell: raw count value (firmware passes through)
        // append: direct value
        await bleService.setQueryParam(interval, dwell, append || 0);
        connection.setSettings(s => ({ ...s, scanParams: value }));
      }
      connection.addLog(`Updated ${key}`, 'info');
    } catch (e: any) {
      connection.addLog(`Settings Update Failed: ${e.message}`, 'error');
    }
  };

  const handleSaveSetting = async (key: string, value: any) => {
    try {
      if (key === 'tagFocus') {
        await bleService.sendCommand({ cmd: 'STF', val: value ? 1 : 0 });
        connection.addLog(`Saved Tag Focus: ${value}`, 'info');
      } else if (key === 'fastTid') {
        await bleService.sendCommand({ cmd: 'STID', val: value ? 1 : 0 });
        connection.addLog(`Saved Fast TID: ${value}`, 'info');
      }
    } catch (e: any) {
      connection.addLog(`Save Setting Failed: ${e.message}`, 'error');
    }
  };

  const handleSettingsAction = useCallback((request: SettingsRequest) => {
    if (commandPendingRef.current || pendingWriteRef.current !== null || scan.isScanning || locate.isLocating || isBatchSaving || fileTransfer.isFileTransferring) return;
    return settingsActions.run(request);
  }, [scan.isScanning, locate.isLocating, isBatchSaving, fileTransfer.isFileTransferring, settingsActions.run]);

  const handleApplyPreset = async (mode: 'standard' | 'quick' | 'deep') => {
    try {
      if (mode === 'standard') {
        // Profile 53, Q=4, Session=1, TagFocus=Enable
        await bleService.setBaseband(53, 4, 1);
        await bleService.setTagFocus(true);
        connection.addLog('Applied Standard Mode', 'info');
      } else if (mode === 'quick') {
        // Profile 11, Q=2, Session=0, TagFocus=Disable
        await bleService.setBaseband(11, 2, 0);
        await bleService.setTagFocus(false);
        connection.addLog('Applied Quick Scan Mode', 'info');
      } else if (mode === 'deep') {
        // Profile 13, Q=4, Session=1
        await bleService.setBaseband(13, 4, 1);
        await bleService.setTagFocus(true);
        connection.addLog('Applied Deep Scan Mode', 'info');
      }
      await bleService.getProfile();
      await bleService.getQSession();
      await bleService.getTagFocus();
    } catch (e: any) {
      connection.addLog(`Failed to apply preset: ${e.message}`, 'error');
      throw e;
    }
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
      
      onUpdateSettings={handleUpdateSettings}
      onSaveSetting={handleSaveSetting}
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

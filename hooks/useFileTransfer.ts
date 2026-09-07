import { useCallback, useEffect, useRef, useState } from 'react';
import { bleService } from '../services/bleService';
import { BatchHistoryRecord, FileTransferStatus } from '../types';
import { parseNhrbFile } from '../utils/nhrbParser';

const BUSY_RETRY_DELAY_MS = 1200;
const MAX_BUSY_RETRIES = 8;

export const useFileTransfer = (addLog: (msg: string, type: 'info' | 'error' | 'rx' | 'tx') => void) => {
  const [isFileTransferring, setIsFileTransferring] = useState(false);
  const [transferProgress, setTransferProgress] = useState(0);
  const [transferStatus, setTransferStatus] = useState<FileTransferStatus>('idle');
  const [historyData, setHistoryData] = useState<BatchHistoryRecord[]>([]);
  const busyRetryCountRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearRetryTimer(), [clearRetryTimer]);

  const requestFileFromDevice = useCallback(async () => {
    setIsFileTransferring(true);
    setTransferStatus('requesting');
    setTransferProgress(0);
    await bleService.requestFileTransfer();
  }, []);

  const scheduleBusyRetry = useCallback(() => {
    clearRetryTimer();

    if (busyRetryCountRef.current >= MAX_BUSY_RETRIES) {
      setIsFileTransferring(false);
      setTransferStatus('error');
      addLog('Device is still busy saving batch data. Fetch cancelled after retries.', 'error');
      return;
    }

    busyRetryCountRef.current += 1;
    setIsFileTransferring(true);
    setTransferStatus('saving');
    setTransferProgress(0);
    addLog(`Device is saving batch data. Retrying fetch ${busyRetryCountRef.current}/${MAX_BUSY_RETRIES}...`, 'info');

    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      requestFileFromDevice().catch((error: any) => {
        setIsFileTransferring(false);
        setTransferStatus('error');
        addLog(`Fetch History Failed: ${error.message}`, 'error');
      });
    }, BUSY_RETRY_DELAY_MS);
  }, [addLog, clearRetryTimer, requestFileFromDevice]);

  const handleFileCallback = useCallback((event: string, data?: any) => {
    if (event === 'request') {
      setIsFileTransferring(true);
      setTransferStatus('requesting');
      setTransferProgress(0);
      addLog('File request sent to FF02', 'info');
      return;
    }

    if (event === 'start') {
      setIsFileTransferring(true);
      setTransferStatus('transferring');
      setTransferProgress(0);
      addLog(`Receiving NHRB batch file (${data?.total ?? 0} bytes, ${data?.chunks ?? 0} chunks)`, 'info');
      return;
    }

    if (event === 'progress') {
      setTransferProgress(typeof data === 'number' ? data : 0);
      return;
    }

    if (event === 'busy') {
      scheduleBusyRetry();
      return;
    }

    if (event === 'complete') {
      clearRetryTimer();
      setTransferStatus('parsing');
      setTransferProgress(100);

      try {
        const fileBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        const parsed = parseNhrbFile(fileBytes);
        const records = parsed.epcs.map((epc, index) => ({
          INDEX: index + 1,
          EPC: epc,
        }));

        setHistoryData(records);
        setIsFileTransferring(false);
        setTransferStatus('complete');
        addLog(`NHRB parsed successfully. Loaded ${records.length} unique EPCs.`, 'info');
      } catch (e: any) {
        setHistoryData([]);
        setIsFileTransferring(false);
        setTransferStatus('error');
        addLog(`Failed to parse NHRB file: ${e.message}`, 'error');
      }
      return;
    }

    if (event === 'error') {
      clearRetryTimer();
      setIsFileTransferring(false);
      setTransferStatus('error');
      addLog(`File Transfer Error: ${data}`, 'error');
    }
  }, [addLog, clearRetryTimer, scheduleBusyRetry]);

  const fetchHistory = async () => {
    try {
      clearRetryTimer();
      busyRetryCountRef.current = 0;
      setHistoryData([]);
      await requestFileFromDevice();
    } catch (e: any) {
      setIsFileTransferring(false);
      setTransferStatus('error');
      addLog(e.message, 'error');
    }
  };

  const downloadJson = () => {
    if (historyData.length === 0) return;
    try {
      const jsonString = JSON.stringify(historyData, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `batch_epc_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addLog('JSON Downloaded', 'info');
    } catch (e) {
      addLog('Failed to download JSON', 'error');
    }
  };

  const downloadCsv = () => {
    if (historyData.length === 0) return;
    try {
      const headers: Array<keyof BatchHistoryRecord> = ['INDEX', 'EPC'];
      const csvRows = [headers.join(',')];

      for (const row of historyData) {
        const values = headers.map((header) => {
          const escaped = String(row[header]).replace(/"/g, '""');
          return `"${escaped}"`;
        });
        csvRows.push(values.join(','));
      }

      const csvString = csvRows.join('\n');
      const blob = new Blob([csvString], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `batch_epc_${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addLog('CSV Downloaded', 'info');
    } catch (e) {
      addLog('Failed to download CSV', 'error');
    }
  };

  const downloadTxt = () => {
    if (historyData.length === 0) return;
    try {
      let txtContent = `BATCH EPC EXPORT - ${new Date().toLocaleString()}\n`;
      txtContent += `Unique EPCs: ${historyData.length}\n`;
      txtContent += `----------------------------------------\n\n`;

      historyData.forEach((record) => {
        txtContent += `${record.INDEX}. ${record.EPC}\n`;
      });

      const blob = new Blob([txtContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `batch_epc_${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addLog('TXT Downloaded', 'info');
    } catch (e) {
      addLog('Failed to download TXT', 'error');
    }
  };

  const shareFile = async () => {
    if (historyData.length === 0) return;
    try {
      const jsonString = JSON.stringify(historyData, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const file = new File([blob], `batch_epc_${Date.now()}.json`, { type: 'application/json' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: 'RFID Batch EPC List',
          text: `Batch export with ${historyData.length} unique EPCs.`,
          files: [file],
        });
        addLog('File Shared successfully', 'info');
      } else {
        addLog('Sharing not supported on this device/browser', 'error');
      }
    } catch (e: any) {
      addLog(`Share failed: ${e.message}`, 'error');
    }
  };

  const clearFileData = () => {
    clearRetryTimer();
    setHistoryData([]);
    setTransferProgress(0);
    setTransferStatus('idle');
    setIsFileTransferring(false);
  };

  return {
    isFileTransferring,
    transferProgress,
    transferStatus,
    historyData,
    handleFileCallback,
    fetchHistory,
    downloadJson,
    downloadCsv,
    downloadTxt,
    shareFile,
    clearFileData
  };
};

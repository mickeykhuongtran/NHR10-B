import { useState, useCallback, useEffect, useRef } from 'react';
import { bleService } from '../services/bleService';
import { LocateSignalState } from '../types';

// NHR-10 sends F/rssi=-100 once when the target has not been read for 2 s.
// Allow a small BLE margin, then expire a stale reading if that packet was lost.
export const LOCATE_STALE_MS = 2500;
const LOST_RSSI = -100;

export const useLocateLogic = (addLog: (msg: string, type: 'info' | 'error' | 'rx' | 'tx') => void) => {
  const [isLocating, setIsLocating] = useState(false);
  const [targetRssi, setTargetRssi] = useState<number | null>(null);
  const [signalState, setSignalState] = useState<LocateSignalState>('idle');
  const targetRef = useRef<string | null>(null);
  const sessionRef = useRef(0);
  const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearStaleTimer = useCallback(() => {
    if (staleTimer.current !== null) clearTimeout(staleTimer.current);
    staleTimer.current = null;
  }, []);
  useEffect(() => () => { targetRef.current = null; sessionRef.current++; clearStaleTimer(); }, [clearStaleTimer]);

  const resetLocateState = useCallback(() => {
    targetRef.current = null;
    sessionRef.current++;
    clearStaleTimer();
    setIsLocating(false);
    setTargetRssi(null);
    setSignalState('idle');
  }, [clearStaleTimer]);

  const handleDataReceived = useCallback((data: any) => {
    if (data.cmd !== 'F' || !targetRef.current) return;
    if (data.epc !== undefined && (typeof data.epc !== 'string' || data.epc.toUpperCase() !== targetRef.current)) return;
    if (typeof data.rssi !== 'number' || !Number.isFinite(data.rssi)) return;
    clearStaleTimer();
    if (data.rssi === LOST_RSSI) {
      setTargetRssi(null);
      setSignalState('lost');
      return;
    }
    setTargetRssi(data.rssi);
    setSignalState('detected');
    staleTimer.current = setTimeout(() => {
      staleTimer.current = null;
      setTargetRssi(null);
      setSignalState('lost');
    }, LOCATE_STALE_MS);
  }, [clearStaleTimer]);

  const startLocate = async (epc: string) => {
    if (typeof epc !== 'string' || !/^[0-9a-f]+$/i.test(epc) || epc.length % 4 !== 0) {
      addLog('Invalid EPC format for Locate. Use complete hexadecimal words.', 'error');
      return;
    }
    if (targetRef.current) return;
    const session = ++sessionRef.current;
    targetRef.current = epc.toUpperCase();
    clearStaleTimer();
    setTargetRssi(null);
    setSignalState('waiting');
    setIsLocating(true);
    try {
      // Activate the receiver before sending F, so a fast first response is kept.
      await bleService.locateTag(targetRef.current);
      if (session === sessionRef.current) addLog(`Locating Started: ${epc}`, 'info');
    } catch (e: any) {
      if (session !== sessionRef.current) return;
      resetLocateState();
      addLog(`Locate Error: ${e.message}`, 'error');
    }
  };

  const stopLocate = async () => {
    const session = sessionRef.current;
    try {
      await bleService.stopScan();
      if (session !== sessionRef.current) return;
      resetLocateState();
      addLog('Locating Stopped', 'info');
    } catch (e: any) {
      if (session === sessionRef.current) addLog(`Stop Locate Error: ${e.message}`, 'error');
    }
  };

  return { isLocating, targetRssi, signalState, startLocate, stopLocate, resetLocateState, handleDataReceived };
};

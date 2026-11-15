import { useCallback, useEffect, useRef, useState } from 'react';
import { bleService } from '../services/bleService';
import { ConnectionStatus } from '../types';
import { defaultInsuranceConfig, InsuranceConfig, InsuranceSnapshot, parseInsuranceConfig, parseInsuranceSnapshot, validInsuranceConfig } from '../utils/tagInsurance';

export function useTagInsurance(status: ConnectionStatus, revision: number) {
  const [snapshot, setSnapshot] = useState<InsuranceSnapshot | null>(null);
  const [config, setConfig] = useState(defaultInsuranceConfig);
  const [durationSupported, setDurationSupported] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const snapshotRef = useRef<InsuranceSnapshot | null>(null);
  const desired = useRef<boolean | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);

  const query = useCallback(async () => {
    const epoch = generation.current;
    try { await bleService.sendCommand({ cmd: 'GTI' }); }
    catch (e) { if (epoch === generation.current) setError(e instanceof Error ? e.message : 'Status query failed'); }
  }, []);
  const handleDataReceived = useCallback((data: Record<string, unknown>) => {
    if (data.cmd === 'TIC') {
      const c = parseInsuranceConfig(data);
      if (c) { setConfig(c); setDurationSupported(data.dur !== undefined); }
      return true;
    }
    if (data.cmd !== 'TI' && data.cmd !== 'GTI') return false;
    if (data.status === 'err') {
      clearTimer(); desired.current = null; setPending(false);
      snapshotRef.current = null; setSnapshot(null);
      setError(`Device: ${String(data.error ?? data.msg ?? 'Insurance unavailable')}. Query status before retrying.`);
      return true;
    }
    const next = parseInsuranceSnapshot(data);
    if (!next) return true;
    if (data.dur !== undefined) setDurationSupported(true);
    snapshotRef.current = next;
    setSnapshot(next);
    setError(current => current.startsWith('No Insurance status') || current.startsWith('Device: booting') ||
      current.startsWith('Mode confirmation timed out') ? '' : current);
    if (desired.current === null || next.enabled === desired.current) {
      if (desired.current !== null) setError('');
      clearTimer(); desired.current = null; setPending(false);
    }
    return true;
  }, [clearTimer]);

  useEffect(() => {
    ++generation.current;
    snapshotRef.current = null; desired.current = null;
    setSnapshot(null); setPending(false); setError(''); clearTimer();
    setConfig(defaultInsuranceConfig); setDurationSupported(null);
    if (status !== 'connected') return;
    void query();
    timer.current = setTimeout(() => setError('No Insurance status received. Query again; this feature needs the validate-tag firmware.'), 6000);
    return clearTimer;
  }, [status, revision, query, clearTimer]);

  useEffect(() => {
    if (status !== 'connected') return;
    // The final result is retained on the device. Recover a missed notification
    // without altering the live-tag protocol or relying on host timing.
    const interval = setInterval(() => {
      if (desired.current === null && (!snapshotRef.current || snapshotRef.current.enabled)) void query();
    }, 1500);
    return () => clearInterval(interval);
  }, [status, query]);

  const setMode = useCallback(async (enabled: boolean, nextConfig: InsuranceConfig) => {
    if (status !== 'connected' || desired.current !== null || !snapshotRef.current ||
        (enabled && !validInsuranceConfig(nextConfig))) return;
    if (enabled && durationSupported !== true && nextConfig.dur !== defaultInsuranceConfig.dur) {
      setError('Custom Remain Time needs updated firmware. Refresh status to confirm support before enabling.');
      return;
    }
    const epoch = generation.current;
    desired.current = enabled; setPending(true); setError(''); clearTimer();
    timer.current = setTimeout(() => {
      // Do not infer OFF from a missing acknowledgement: the device may have
      // activated the mode while the reply was lost.
      desired.current = null; snapshotRef.current = null;
      setSnapshot(null); setPending(false);
      setError('Mode confirmation timed out. Query device status before continuing.');
      void query();
    }, 45000);
    try { await bleService.sendCommand(enabled ? { cmd: 'TI', val: 1, ...nextConfig } : { cmd: 'TI', val: 0 }); }
    catch (e) {
      if (epoch !== generation.current) return;
      clearTimer(); desired.current = null; snapshotRef.current = null;
      setSnapshot(null); setPending(false); setError(e instanceof Error ? e.message : 'Mode command failed');
      void query();
    }
  }, [status, durationSupported, query, clearTimer]);
  const isLocked = useCallback(() => desired.current !== null || !snapshotRef.current || snapshotRef.current.enabled, []);
  return { snapshot, config, durationSupported, pending, error, locked: pending || !snapshot || snapshot.enabled,
    isLocked, query, setMode, handleDataReceived };
}
export type TagInsuranceController = ReturnType<typeof useTagInsurance>;

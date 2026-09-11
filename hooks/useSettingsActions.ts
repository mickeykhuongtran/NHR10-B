import { useCallback, useEffect, useRef, useState } from 'react';
import { bleService } from '../services/bleService';
import { ConnectionStatus, LogEntry, RegionStatusUpdate, RegionSupport } from '../types';
import { DeviceCommand, SettingId, SettingReading, SettingsRequest, SETTING_META, describeSetting, isSettingsBusy, isSettingsError, parseSettingReading, prepareSettingApply } from '../utils/settingsProtocol';
import { isRegionApplyConfirmed, parseRegionReading } from '../utils/regionBand';

export const SETTINGS_READ_TIMEOUT_MS = 5000;
export const SETTINGS_ACK_TIMEOUT_MS = 4000;
export const REGION_APPLY_TIMEOUT_MS = 5000;
export const REGION_ERROR_COOLDOWN_MS = 1000;
export type SettingsActivity = { id: SettingsRequest['id']; mode: SettingsRequest['mode']; phase: 'Reading' | 'Applying' | 'Verifying' | 'Saving' | 'Waiting'; title: string };
type Step = { commands: string[]; receive: (data: any) => void; cancel: (error: Error) => void; busy: boolean };
class SettingsTimeout extends Error {}
class SettingsBusy extends Error {}
class SettingsDeviceError extends Error {
  constructor(public data: any) {
    super(`${data.cmd}: ${data.error ?? data.msg ?? data.code ?? 'device rejected the command'}${data.error && data.code !== undefined ? ` (${data.code})` : ''}`);
  }
}
const unsupportedCommand = (error: unknown) => error instanceof SettingsDeviceError && [error.data.error, error.data.msg, error.data.code]
  .some(value => /^(unsupported|not_supported|unsupported_command|unknown_command|unknown_cmd|invalid_command)$/i.test(String(value)));
const sendBleCommand = (command: DeviceCommand) => bleService.sendCommand(command);
const noOp = () => {};
const configCommands = new Set(Object.values(SETTING_META).flatMap(meta => meta.set ? [meta.get, meta.set] : [meta.get]));

export function useSettingsActions(
  addLog: (message: string, type: LogEntry['type'], notice?: LogEntry['notice']) => void,
  status: ConnectionStatus,
  sendCommand = sendBleCommand,
  invalidateProfile = noOp,
  updateRegionStatus: (update: RegionStatusUpdate) => void = noOp,
) {
  const [activity, setActivity] = useState<SettingsActivity | null>(null);
  const stepRef = useRef<Step | null>(null);
  const activeRef = useRef(false);
  const recoveryRef = useRef<'profile' | 'baseband' | 'region-band' | null>(null);
  const regionReadConfirmed = useRef(false);
  const regionSupport = useRef<RegionSupport>('unknown');
  const regionWritesUnsupported = useRef(false);
  const regionCooldownUntil = useRef(0);
  const regionApplyDeadline = useRef(0);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const connected = useRef(status === 'connected');
  const generation = useRef(0);
  const previousStatus = useRef(status);
  if (previousStatus.current !== status) {
    generation.current++; previousStatus.current = status;
    regionReadConfirmed.current = false; regionSupport.current = 'unknown';
    regionWritesUnsupported.current = false; regionCooldownUntil.current = 0;
  }
  connected.current = status === 'connected';
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stepRef.current?.cancel(new Error('Settings operation closed.')); };
  }, []);
  useEffect(() => {
    if (status !== 'connected') stepRef.current?.cancel(new Error('Connection lost before confirmation. Reconnect and read the setting again.'));
  }, [status]);

  const handleDataReceived = useCallback((data: any): boolean => {
    if (['GF', 'SF'].includes(data.cmd) && isSettingsError(data) && !isSettingsBusy(data)) regionCooldownUntil.current = Date.now() + REGION_ERROR_COOLDOWN_MS;
    const step = stepRef.current;
    if (!step || (data.cmd === 'SAVE' && data.mode === 'batch')) return false;
    // A busy reply belongs to the rejected request. A later terminal reply may
    // belong to the operation already running; it is never our success ACK.
    if (step.busy && configCommands.has(data.cmd) && !isSettingsBusy(data) && (data.status === 'ok' || isSettingsError(data))) {
      step.cancel(new SettingsBusy('Reader finished the previous operation.'));
      return true;
    }
    if (!step.commands.includes(data.cmd)) return false;
    step.receive(data);
    return true;
  }, []);

  const waitOnce = useCallback((command: DeviceCommand, commands: string[], timeout: number, accept: (data: any) => boolean) => new Promise<any>((resolve, reject) => {
    if (!connected.current || !mounted.current) { reject(new Error('Reader is not connected.')); return; }
    const finish = (error?: Error, data?: any) => {
      if (stepRef.current !== step) return;
      clearTimeout(timer);
      stepRef.current = null;
      if (error && !(error instanceof SettingsBusy) && ['GF', 'SF'].includes(command.cmd)) regionCooldownUntil.current = Date.now() + REGION_ERROR_COOLDOWN_MS;
      if (error) reject(error); else resolve(data);
    };
    const step: Step = {
      commands, busy: false,
      cancel: error => finish(error),
      receive: data => {
        if (isSettingsBusy(data)) {
          if (!step.busy) {
            clearTimeout(timer);
            timer = setTimeout(() => finish(new SettingsBusy('Reader is busy.')), timeout);
          }
          step.busy = true;
          if (mounted.current) setActivity(current => current ? { ...current, phase: 'Waiting' } : current);
        } else if (isSettingsError(data)) finish(new SettingsDeviceError(data));
        else if (!step.busy && accept(data)) finish(undefined, data);
      },
    };
    // If firmware supplies no completion event, allow its full operation window
    // before a bounded busy retry. Telemetry cannot release this wait.
    let timer = setTimeout(() => finish(new SettingsTimeout(`No valid ${command.cmd} response from the reader. Read again or check firmware support in Diagnostics.`)), timeout);
    stepRef.current = step;
    if (command.cmd === 'SF') regionApplyDeadline.current = Date.now() + REGION_APPLY_TIMEOUT_MS;
    Promise.resolve().then(() => {
      if (stepRef.current !== step || !connected.current || !mounted.current) return;
      return sendCommand(command);
    }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  }), [sendCommand]);

  const waitForRegionCooldown = useCallback(() => new Promise<void>((resolve, reject) => {
    const remaining = regionCooldownUntil.current - Date.now();
    if (remaining <= 0) { resolve(); return; }
    if (!connected.current || !mounted.current) { reject(new Error('Reader is not connected.')); return; }
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (stepRef.current === step) stepRef.current = null;
      if (error) reject(error); else resolve();
    };
    const step: Step = { commands: [], busy: false, receive: noOp, cancel: finish };
    const timer = setTimeout(() => finish(), remaining);
    stepRef.current = step;
  }), []);

  const waitForReply = useCallback(async (...args: Parameters<typeof waitOnce>) => {
    const started = generation.current;
    for (let retry = 0; ; retry++) {
      if (generation.current !== started) throw new Error('Connection changed before confirmation.');
      if (['GF', 'SF'].includes(args[0].cmd)) await waitForRegionCooldown();
      if (generation.current !== started) throw new Error('Connection changed before confirmation.');
      try { return await waitOnce(...args); }
      catch (error) { if (!(error instanceof SettingsBusy) || retry >= 2) throw error; }
    }
  }, [waitOnce, waitForRegionCooldown]);

  const read = useCallback(async (id: SettingId, timeout = SETTINGS_READ_TIMEOUT_MS): Promise<SettingReading> => {
    const started = generation.current;
    const meta = SETTING_META[id];
    // Consume late legacy ACKs during verification so App does not schedule a
    // duplicate fallback GET. RF recovery accepts only its fresh GET response.
    const commands = [meta.get, ...(['profile', 'baseband', 'region-band'].includes(id) ? [] : meta.setReplies)];
    if (['q-session', 'query-params', 'tag-focus'].includes(id)) commands.push('GCFG');
    try {
      if (timeout <= 0) throw new SettingsTimeout('Region apply verification exceeded 5 seconds.');
      const response = await waitForReply({ cmd: meta.get }, commands, timeout, data => data.cmd === meta.get && parseSettingReading(id, data) !== null);
      if (!mounted.current || !connected.current || started !== generation.current) throw new Error('Connection changed before confirmation.');
      if (id === 'region-band') {
        regionReadConfirmed.current = true;
        regionSupport.current = regionWritesUnsupported.current ? 'unavailable' : 'supported';
        updateRegionStatus({ confirmed: true, support: regionSupport.current, reading: parseRegionReading(response)! });
      }
      if (id === recoveryRef.current) recoveryRef.current = null;
      return parseSettingReading(id, response)!;
    } catch (error) {
      if (id === 'region-band' && mounted.current && connected.current && started === generation.current) {
        regionReadConfirmed.current = false;
        if (unsupportedCommand(error) || (regionSupport.current === 'unknown' && error instanceof SettingsTimeout)) regionSupport.current = 'unavailable';
        updateRegionStatus({ confirmed: false, support: regionSupport.current, error: error instanceof Error ? error.message : 'Region read failed.' });
      }
      throw error;
    }
  }, [updateRegionStatus, waitForReply]);

  const execute = useCallback(async (request: SettingsRequest, silent = false): Promise<boolean> => {
    const started = generation.current;
    const attempt = ++sequence.current;
    const title = request.id === 'config' ? 'Configuration' : SETTING_META[request.id].title;
    const setPhase = (phase: SettingsActivity['phase']) => { if (mounted.current) setActivity({ id: request.id, mode: request.mode, phase, title }); };
    let rfWriteStarted = false;
    let regionWriteStarted = false;
    try {
      if (request.id === 'region-band' && request.mode === 'read') {
        if (silent && regionSupport.current === 'unavailable') return false;
        regionReadConfirmed.current = false;
        updateRegionStatus({ confirmed: false, error: null });
      }
      if (recoveryRef.current && request.mode !== 'read') {
        setPhase('Verifying');
        await read(recoveryRef.current);
      }
      if (request.mode === 'save') {
        setPhase('Saving');
        await waitForReply({ cmd: 'SAVE' }, ['SAVE'], SETTINGS_READ_TIMEOUT_MS, data => data.status === 'ok');
        addLog('The reader confirmed that the configuration was saved.', 'info', { id: `settings-${attempt}`, title: 'Configuration saved' });
        return true;
      }
      const meta = SETTING_META[request.id];
      const rfWrite = request.mode === 'apply' && (request.id === 'profile' || request.id === 'baseband');
      const regionWrite = request.id === 'region-band' && request.mode === 'apply';
      let expected: SettingReading | null = null;
      if (request.mode === 'apply') {
        const prepared = prepareSettingApply(request);
        expected = prepared.expected;
        if (regionWrite && (!regionReadConfirmed.current || regionSupport.current !== 'supported')) throw new Error('Read Region successfully on this connection before applying a preset.');
        setPhase('Applying');
        if (rfWrite) { rfWriteStarted = true; invalidateProfile(); }
        if (regionWrite) {
          regionWriteStarted = true; regionReadConfirmed.current = false;
          updateRegionStatus({ confirmed: false, error: null });
        }
        try {
          const ack = await waitForReply(prepared.command, meta.setReplies, regionWrite ? REGION_APPLY_TIMEOUT_MS : SETTINGS_ACK_TIMEOUT_MS, data => rfWrite || regionWrite
            ? data.cmd === meta.set && data.status === 'ok'
            : data.status === 'ok' || parseSettingReading(request.id, data) !== null);
          if (rfWrite) {
            const reading = parseSettingReading(request.id, ack);
            if (ack.persisted !== true || !reading || !Object.entries(expected).every(([key, value]) => reading[key] === value)) {
              throw new Error(`${meta.set}: saved value was not confirmed (matching val and persisted:true required).`);
            }
          }
          if (regionWrite && !isRegionApplyConfirmed(ack, request.value.selection, request.value.save)) {
            throw new Error('SF: matching band/channel limits, verified:true and the requested saved flag were not confirmed.');
          }
        } catch (error) {
          if (rfWrite || regionWrite || !(error instanceof SettingsTimeout)) throw error;
        }
      }
      setPhase(request.mode === 'read' ? 'Reading' : 'Verifying');
      const reading = await read(request.id, regionWrite ? regionApplyDeadline.current - Date.now() : SETTINGS_READ_TIMEOUT_MS);
      if (regionWrite && Date.now() > regionApplyDeadline.current) throw new SettingsTimeout('Region apply verification exceeded 5 seconds.');
      const description = describeSetting(request.id, reading);
      if (expected && !Object.entries(expected).every(([key, value]) => reading[key] === value)) {
        throw new Error(`Read-back differs from the requested value. Reader reports ${description}. Review the setting before retrying.`);
      }
      if (!silent) addLog(`${title}: ${description}.`, 'info', { id: `settings-${attempt}`, title: request.mode === 'read' ? 'Read successful' : regionWrite ? (request.value.save ? 'Đã lưu' : 'Đã áp dụng tạm thời') : rfWrite ? 'Đã lưu' : 'Applied and verified' });
      return true;
    } catch (error) {
      if (mounted.current) addLog(`${title}: ${error instanceof Error ? error.message : 'Device command failed.'}`, 'error', { id: `settings-${attempt}`, title: request.mode === 'read' ? 'Read not confirmed' : request.mode === 'save' ? 'Save not confirmed' : 'Apply not confirmed' });
      if (rfWriteStarted || regionWriteStarted) {
        recoveryRef.current = request.id as 'profile' | 'baseband' | 'region-band';
        if (rfWriteStarted) invalidateProfile();
        if (regionWriteStarted) {
          regionReadConfirmed.current = false;
          if (unsupportedCommand(error)) { regionWritesUnsupported.current = true; regionSupport.current = 'unavailable'; }
          if (mounted.current && connected.current && started === generation.current) updateRegionStatus({ confirmed: false, support: regionSupport.current, error: error instanceof Error ? error.message : 'Region apply failed.' });
          regionCooldownUntil.current = Date.now() + REGION_ERROR_COOLDOWN_MS;
        }
        if (connected.current && mounted.current) {
          setPhase('Verifying');
          try { await read(recoveryRef.current); }
          catch (recoveryError) {
            if (mounted.current) addLog(`Current ${regionWriteStarted ? 'Region' : 'RF'} configuration is unconfirmed: ${recoveryError instanceof Error ? recoveryError.message : 'read failed'}`, 'error');
          }
        }
      }
      return false;
    }
  }, [addLog, invalidateProfile, read, updateRegionStatus, waitForReply]);

  const runSequence = useCallback(async (requests: SettingsRequest[], options: { silent?: boolean; continueOnReadError?: boolean } = {}): Promise<boolean> => {
    if (activeRef.current || !connected.current) return false;
    activeRef.current = true;
    const started = generation.current;
    let success = true;
    try {
      for (const request of requests) {
        if (!mounted.current || !connected.current || started !== generation.current) return false;
        if (!await execute(request, options.silent)) {
          success = false;
          if (!options.continueOnReadError || request.mode !== 'read') return false;
        }
      }
      return success;
    } finally {
      activeRef.current = false;
      if (mounted.current) setActivity(null);
    }
  }, [execute]);
  const run = useCallback((request: SettingsRequest) => runSequence([request]), [runSequence]);
  const isPending = useCallback(() => activeRef.current, []);
  return { activity, run, runSequence, handleDataReceived, isPending };
}

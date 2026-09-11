import { useCallback, useEffect, useRef, useState } from 'react';
import { bleService } from '../services/bleService';
import { ConnectionStatus, LogEntry } from '../types';
import { DeviceCommand, SettingId, SettingReading, SettingsRequest, SETTING_META, describeSetting, isSettingsBusy, isSettingsError, parseSettingReading, prepareSettingApply } from '../utils/settingsProtocol';

export const SETTINGS_READ_TIMEOUT_MS = 5000;
export const SETTINGS_ACK_TIMEOUT_MS = 4000;
export type SettingsActivity = { id: SettingsRequest['id']; mode: SettingsRequest['mode']; phase: 'Reading' | 'Applying' | 'Verifying' | 'Saving' | 'Waiting'; title: string };
type Step = { commands: string[]; receive: (data: any) => void; cancel: (error: Error) => void; busy: boolean };
class SettingsTimeout extends Error {}
class SettingsBusy extends Error {}
const sendBleCommand = (command: DeviceCommand) => bleService.sendCommand(command);
const noOp = () => {};
const configCommands = new Set(Object.values(SETTING_META).flatMap(meta => [meta.get, meta.set]));

export function useSettingsActions(
  addLog: (message: string, type: LogEntry['type'], notice?: LogEntry['notice']) => void,
  status: ConnectionStatus,
  sendCommand = sendBleCommand,
  invalidateProfile = noOp,
) {
  const [activity, setActivity] = useState<SettingsActivity | null>(null);
  const stepRef = useRef<Step | null>(null);
  const activeRef = useRef(false);
  const recoveryRef = useRef<'profile' | 'baseband' | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const connected = useRef(status === 'connected');
  const generation = useRef(0);
  const previousStatus = useRef(status);
  if (previousStatus.current !== status) { generation.current++; previousStatus.current = status; }
  connected.current = status === 'connected';
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stepRef.current?.cancel(new Error('Settings operation closed.')); };
  }, []);
  useEffect(() => {
    if (status !== 'connected') stepRef.current?.cancel(new Error('Connection lost before confirmation. Reconnect and read the setting again.'));
  }, [status]);

  const handleDataReceived = useCallback((data: any): boolean => {
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
        } else if (isSettingsError(data)) finish(new Error(`${data.cmd}: ${data.error ?? data.msg ?? data.code ?? 'device rejected the command'}`));
        else if (!step.busy && accept(data)) finish(undefined, data);
      },
    };
    // If firmware supplies no completion event, allow its full operation window
    // before a bounded busy retry. Telemetry cannot release this wait.
    let timer = setTimeout(() => finish(new SettingsTimeout(`No valid ${command.cmd} response from the reader. Read again or check firmware support in Diagnostics.`)), timeout);
    stepRef.current = step;
    Promise.resolve().then(() => {
      if (stepRef.current !== step || !connected.current || !mounted.current) return;
      return sendCommand(command);
    }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  }), [sendCommand]);

  const waitForReply = useCallback(async (...args: Parameters<typeof waitOnce>) => {
    const started = generation.current;
    for (let retry = 0; ; retry++) {
      if (generation.current !== started) throw new Error('Connection changed before confirmation.');
      try { return await waitOnce(...args); }
      catch (error) { if (!(error instanceof SettingsBusy) || retry >= 2) throw error; }
    }
  }, [waitOnce]);

  const read = useCallback(async (id: SettingId): Promise<SettingReading> => {
    const meta = SETTING_META[id];
    // Consume late legacy ACKs during verification so App does not schedule a
    // duplicate fallback GET. RF recovery accepts only its fresh GET response.
    const commands = [meta.get, ...(['profile', 'baseband'].includes(id) ? [] : meta.setReplies)];
    if (['q-session', 'query-params', 'tag-focus'].includes(id)) commands.push('GCFG');
    const response = await waitForReply({ cmd: meta.get }, commands, SETTINGS_READ_TIMEOUT_MS, data => data.cmd === meta.get && parseSettingReading(id, data) !== null);
    if (id === recoveryRef.current) recoveryRef.current = null;
    return parseSettingReading(id, response)!;
  }, [waitForReply]);

  const execute = useCallback(async (request: SettingsRequest, silent = false): Promise<boolean> => {
    const attempt = ++sequence.current;
    const title = request.id === 'config' ? 'Configuration' : SETTING_META[request.id].title;
    const setPhase = (phase: SettingsActivity['phase']) => { if (mounted.current) setActivity({ id: request.id, mode: request.mode, phase, title }); };
    let rfWriteStarted = false;
    try {
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
      let expected: SettingReading | null = null;
      let acknowledged = false;
      if (request.mode === 'apply') {
        const prepared = prepareSettingApply(request);
        expected = prepared.expected;
        setPhase('Applying');
        if (rfWrite) { rfWriteStarted = true; invalidateProfile(); }
        try {
          const ack = await waitForReply(prepared.command, meta.setReplies, SETTINGS_ACK_TIMEOUT_MS, data => rfWrite
            ? data.cmd === meta.set && data.status === 'ok'
            : data.status === 'ok' || parseSettingReading(request.id, data) !== null);
          if (rfWrite) {
            const reading = parseSettingReading(request.id, ack);
            if (ack.persisted !== true || !reading || !Object.entries(expected).every(([key, value]) => reading[key] === value)) {
              throw new Error(`${meta.set}: saved value was not confirmed (matching val and persisted:true required).`);
            }
          }
          acknowledged = true;
        } catch (error) {
          if (rfWrite || !(error instanceof SettingsTimeout)) throw error;
        }
      }
      setPhase(request.mode === 'read' ? 'Reading' : 'Verifying');
      const reading = await read(request.id);
      const description = describeSetting(request.id, reading);
      if (expected && !Object.entries(expected).every(([key, value]) => reading[key] === value)) {
        throw new Error(`Read-back differs from the requested value. Reader reports ${description}. Review the setting before retrying.`);
      }
      const persistenceNote = request.id === 'region-band' && request.mode === 'apply' && request.value.save && !acknowledged ? ' The active band matches; saving to flash was not confirmed.' : '';
      const renameNote = request.id === 'device-name' && request.mode === 'apply' ? ' The advertising name changes after disconnect.' : '';
      if (!silent) addLog(`${title}: ${description}.${persistenceNote}${renameNote}`, 'info', { id: `settings-${attempt}`, title: request.mode === 'read' ? 'Read successful' : rfWrite ? 'Đã lưu' : 'Applied and verified' });
      return true;
    } catch (error) {
      if (mounted.current) addLog(`${title}: ${error instanceof Error ? error.message : 'Device command failed.'}`, 'error', { id: `settings-${attempt}`, title: request.mode === 'read' ? 'Read not confirmed' : request.mode === 'save' ? 'Save not confirmed' : 'Apply not confirmed' });
      if (rfWriteStarted) {
        recoveryRef.current = request.id as 'profile' | 'baseband';
        invalidateProfile();
        if (connected.current && mounted.current) {
          setPhase('Verifying');
          try { await read(recoveryRef.current); }
          catch (recoveryError) {
            if (mounted.current) addLog(`Current RF configuration is unconfirmed: ${recoveryError instanceof Error ? recoveryError.message : 'read failed'}`, 'error');
          }
        }
      }
      return false;
    }
  }, [addLog, invalidateProfile, read, waitForReply]);

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

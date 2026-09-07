import { useCallback, useEffect, useRef, useState } from 'react';
import { bleService } from '../services/bleService';
import { ConnectionStatus, LogEntry } from '../types';
import { DeviceCommand, SettingsRequest, SETTING_META, describeSetting, isSettingsError, parseSettingReading, prepareSettingApply } from '../utils/settingsProtocol';

export const SETTINGS_READ_TIMEOUT_MS = 5000;
export const SETTINGS_ACK_TIMEOUT_MS = 1500;
export type SettingsActivity = { id: SettingsRequest['id']; mode: SettingsRequest['mode']; phase: 'Reading' | 'Applying' | 'Verifying' | 'Saving'; title: string };
type Step = { commands: string[]; receive: (data: any) => void; cancel: (error: Error) => void };
class SettingsTimeout extends Error {}
const sendBleCommand = (command: DeviceCommand) => bleService.sendCommand(command);

export function useSettingsActions(
  addLog: (message: string, type: LogEntry['type'], notice?: LogEntry['notice']) => void,
  status: ConnectionStatus,
  sendCommand = sendBleCommand,
) {
  const [activity, setActivity] = useState<SettingsActivity | null>(null);
  const stepRef = useRef<Step | null>(null);
  const activeRef = useRef(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const connected = useRef(status === 'connected');
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
    if (!step || !step.commands.includes(data.cmd) || (data.cmd === 'SAVE' && data.mode === 'batch')) return false;
    step.receive(data);
    return true;
  }, []);

  const waitForReply = useCallback((command: DeviceCommand, commands: string[], timeout: number, accept: (data: any) => boolean) => new Promise<any>((resolve, reject) => {
    if (!connected.current || !mounted.current) { reject(new Error('Reader is not connected.')); return; }
    const finish = (error?: Error, data?: any) => {
      if (stepRef.current !== step) return;
      clearTimeout(timer);
      stepRef.current = null;
      if (error) reject(error); else resolve(data);
    };
    const step: Step = {
      commands,
      cancel: error => finish(error),
      receive: data => {
        if (isSettingsError(data)) finish(new Error(`${data.cmd}: ${data.msg ?? data.code ?? 'device rejected the command'}`));
        else if (accept(data)) finish(undefined, data);
      },
    };
    const timer = setTimeout(() => finish(new SettingsTimeout(`No valid ${command.cmd} response from the reader. Read again or check firmware support in Diagnostics.`)), timeout);
    stepRef.current = step;
    // Install the receiver first: notifications may arrive before the GATT promise resolves.
    Promise.resolve().then(() => {
      if (stepRef.current !== step || !connected.current || !mounted.current) return;
      return sendCommand(command);
    }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  }), [sendCommand]);

  const run = useCallback(async (request: SettingsRequest) => {
    if (activeRef.current || !connected.current) return;
    activeRef.current = true;
    const attempt = ++sequence.current;
    const title = request.id === 'config' ? 'Configuration' : SETTING_META[request.id].title;
    const setPhase = (phase: SettingsActivity['phase']) => { if (mounted.current) setActivity({ id: request.id, mode: request.mode, phase, title }); };
    try {
      if (request.mode === 'save') {
        setPhase('Saving');
        await waitForReply({ cmd: 'SAVE' }, ['SAVE'], SETTINGS_READ_TIMEOUT_MS, data => data.status === 'ok');
        addLog('The reader confirmed that the configuration was saved.', 'info', { id: `settings-${attempt}`, title: 'Configuration saved' });
        return;
      }
      const meta = SETTING_META[request.id];
      let expected: ReturnType<typeof prepareSettingApply>['expected'] | null = null;
      let acknowledged = false;
      if (request.mode === 'apply') {
        setPhase('Applying');
        const prepared = prepareSettingApply(request);
        expected = prepared.expected;
        try {
          await waitForReply(prepared.command, meta.setReplies, SETTINGS_ACK_TIMEOUT_MS, data => data.status === 'ok' || parseSettingReading(request.id, data) !== null);
          acknowledged = true;
        } catch (error) {
          // Some firmware sends no SLP success ACK. A fresh GET can still verify
          // the actual value. Explicit rejection/transport errors never use this fallback.
          if (!(error instanceof SettingsTimeout)) throw error;
        }
      }
      setPhase(request.mode === 'read' ? 'Reading' : 'Verifying');
      const readCommands = [meta.get, ...meta.setReplies];
      if (['q-session', 'query-params', 'tag-focus'].includes(request.id)) readCommands.push('GCFG');
      const response = await waitForReply({ cmd: meta.get }, readCommands, SETTINGS_READ_TIMEOUT_MS, data => data.cmd === meta.get && parseSettingReading(request.id, data) !== null);
      const reading = parseSettingReading(request.id, response)!;
      const description = describeSetting(request.id, reading);
      if (expected && !Object.entries(expected).every(([key, value]) => reading[key] === value)) {
        throw new Error(`Read-back differs from the requested value. Reader reports ${description}. Review the setting before retrying.`);
      }
      const persistenceNote = request.id === 'region-band' && request.mode === 'apply' && request.value.save && !acknowledged ? ' The active band matches; saving to flash was not confirmed.' : '';
      const renameNote = request.id === 'device-name' && request.mode === 'apply' ? ' The advertising name changes after disconnect.' : '';
      addLog(`${title}: ${description}.${persistenceNote}${renameNote}`, 'info', { id: `settings-${attempt}`, title: request.mode === 'read' ? 'Read successful' : 'Applied and verified' });
    } catch (error) {
      if (mounted.current) addLog(`${title}: ${error instanceof Error ? error.message : 'Device command failed.'}`, 'error', { id: `settings-${attempt}`, title: request.mode === 'read' ? 'Read not confirmed' : request.mode === 'save' ? 'Save not confirmed' : 'Apply not confirmed' });
    } finally {
      activeRef.current = false;
      if (mounted.current) setActivity(null);
    }
  }, [addLog, waitForReply]);

  const isPending = useCallback(() => activeRef.current, []);
  return { activity, run, handleDataReceived, isPending };
}

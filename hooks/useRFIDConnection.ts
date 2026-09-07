import { useState, useEffect, useCallback, useRef } from 'react';
import { bleService } from '../services/bleService';
import { ConnectionStatus, Settings, LogEntry, SettingsSyncRevision } from '../types';
import { parseBatterySnapshot } from '../utils/battery';
import { formatDeviceDisplayName } from '../utils/deviceIdentity';
import { validateBleDeviceName } from '../utils/deviceName';
import { isSettingsError, parseSettingReading } from '../utils/settingsProtocol';

const IDLE_BATTERY_POLL_INTERVAL_MS = 5000;
const IDLE_BATTERY_TIMEOUT_MS = 15000;
const SCAN_NO_TAGS_BATTERY_POLL_INTERVAL_MS = 5000;
const SCAN_LIVE_TAGS_BATTERY_POLL_INTERVAL_MS = 5000;
const BATCH_BATTERY_POLL_INTERVAL_MS = 10000;
const BATCH_BATTERY_TIMEOUT_MS = 30000;
const SCAN_ACTIVITY_TIMEOUT_MS = 15000;
const HEARTBEAT_CHECK_INTERVAL_MS = 500;
const TEMPERATURE_POLL_INTERVAL_MS = 5000;

const parseFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseLinkProfile = (data: any): number | null => (
  parseFiniteNumber(data.val ?? data.profile ?? data.linkProfile ?? data.link_profile)
);

const parseRegionBand = (data: any): Settings['regionBand'] | null => {
  if (data.status === 'err') return null;

  const modeValue = String(data.mode ?? '').toLowerCase();
  const mode = modeValue === 'template' || modeValue === 'custom' ? modeValue : 'unknown';
  const val = typeof data.val === 'string' && data.val.trim() ? data.val.trim().toUpperCase() : mode === 'custom' ? 'CUSTOM' : '';
  const startKHz = parseFiniteNumber(data.start_khz ?? data.start);
  const count = parseFiniteNumber(data.count);
  const space125KHz = parseFiniteNumber(data.space_125khz ?? data.space);
  const stepKHz = parseFiniteNumber(data.step_khz) ?? (space125KHz !== null ? space125KHz * 125 : null);
  const freband = parseFiniteNumber(data.freband);
  const min = parseFiniteNumber(data.min);
  const max = parseFiniteNumber(data.max);

  if (!val && mode === 'unknown' && startKHz === null && count === null) {
    return null;
  }

  return {
    val,
    mode,
    ...(freband !== null ? { freband } : {}),
    ...(min !== null ? { min } : {}),
    ...(max !== null ? { max } : {}),
    ...(startKHz !== null ? { startKHz } : {}),
    ...(count !== null ? { count } : {}),
    ...(space125KHz !== null ? { space125KHz } : {}),
    ...(stepKHz !== null ? { stepKHz } : {}),
    ...(typeof data.save === 'boolean' ? { save: data.save } : {}),
  };
};

type InventoryMode = 'idle' | 'interactive' | 'batch' | 'batchSaving' | 'locate';
type SettingsSyncKey = keyof SettingsSyncRevision;

const createSettingsSyncRevision = (): SettingsSyncRevision => ({
  deviceName: 0,
  power: 0,
  linkProfile: 0,
  qSession: 0,
  queryParams: 0,
  tagFocus: 0,
  regionBand: 0,
});

const bumpSettingsSyncRevision = (settings: Settings, key: SettingsSyncKey): SettingsSyncRevision => {
  const current = settings.syncRevision ?? createSettingsSyncRevision();
  return {
    ...current,
    [key]: current[key] + 1,
  };
};

export const useRFIDConnection = () => {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [inventoryActive, setInventoryActiveState] = useState(false);
  const [inventoryMode, setInventoryModeState] = useState<InventoryMode>('idle');
  const lastBatteryHeartbeatRef = useRef<number | null>(null);
  const lastDeviceActivityRef = useRef<number | null>(null);
  const lastLiveTagsAtRef = useRef<number | null>(null);
  const lastBatteryPollAtRef = useRef(0);
  const inventoryActiveRef = useRef(false);
  const inventoryModeRef = useRef<InventoryMode>('idle');
  const heartbeatTimeoutReportedRef = useRef(false);
  const [settings, setSettings] = useState<Settings>({
    power: 30,
    buzzer: true,
    tagFocus: false,
    fastTid: false,
    linkProfile: 53,
    qValue: 4,
    session: 1,
    scanParams: { interval: 0, dwell: 0, count: 0 },
    version: '1.0.0',
    temperature: 0,
    batterySnapshot: null,
    deviceInfo: '',
    deviceName: '',
    deviceCanonicalId: '',
    syncRevision: createSettingsSyncRevision(),
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info', notice?: LogEntry['notice']) => {
    setLogs(prev => [...prev, { timestamp: Date.now(), message, type, ...(notice ? { notice } : {}) }].slice(-1000));
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const clearDeviceTelemetry = useCallback(() => {
    setSettings(s => ({
      ...s,
      batterySnapshot: s.batterySnapshot
        ? { ...s.batterySnapshot, stale: true }
        : null,
      temperature: 0,
      deviceInfo: '',
      deviceName: '',
      deviceCanonicalId: '',
    }));
  }, []);

  const resetConnectionTracking = useCallback(() => {
    lastBatteryHeartbeatRef.current = null;
    lastDeviceActivityRef.current = null;
    lastLiveTagsAtRef.current = null;
    lastBatteryPollAtRef.current = 0;
    inventoryActiveRef.current = false;
    inventoryModeRef.current = 'idle';
    setInventoryActiveState(false);
    setInventoryModeState('idle');
  }, []);

  const markDeviceActivity = useCallback((cmd?: string) => {
    const now = Date.now();
    lastDeviceActivityRef.current = now;
    if (cmd === 'live_tags') {
      lastLiveTagsAtRef.current = now;
    }
    heartbeatTimeoutReportedRef.current = false;
  }, []);

  const markBatteryHeartbeat = useCallback(() => {
    const now = Date.now();
    lastBatteryHeartbeatRef.current = now;
    // Anchor the next poll to the received snapshot as well as to the write.
    // This keeps every GB exchange at least one firmware refresh period apart.
    lastBatteryPollAtRef.current = now;
    markDeviceActivity('GB');
  }, [markDeviceActivity]);

  const setInventoryActive = useCallback((active: boolean, mode: InventoryMode = active ? 'interactive' : 'idle') => {
    const nextMode = active ? mode : 'idle';
    inventoryActiveRef.current = active;
    inventoryModeRef.current = nextMode;
    setInventoryActiveState(active);
    setInventoryModeState(nextMode);
    if (active && nextMode !== 'batch' && nextMode !== 'batchSaving') {
      markDeviceActivity(nextMode);
    } else {
      lastLiveTagsAtRef.current = null;
    }
  }, [markDeviceActivity]);

  const markDeviceOffline = useCallback((reason = 'Device battery heartbeat timeout') => {
    if (heartbeatTimeoutReportedRef.current) return;
    if (bleService.isIntentionalUnpairPending()) return;

    heartbeatTimeoutReportedRef.current = true;
    resetConnectionTracking();
    const recoveryStarted = bleService.recoverFromUnexpectedLinkTimeout(reason);
    if (!recoveryStarted) {
      setStatus('disconnected');
      clearDeviceTelemetry();
      addLog(reason, 'error');
    }
  }, [addLog, clearDeviceTelemetry, resetConnectionTracking]);

  const handleDataReceived = useCallback((data: any) => {
    markDeviceActivity(data.cmd);

    // 3. Settings Responses
    if (data.cmd === 'DI') {
        const canonicalId = typeof data.id === 'string' && /^NHR10-[0-9A-F]{12}$/i.test(data.id.trim())
          ? data.id.trim().toUpperCase()
          : '';
        const displayId = typeof data.display_id === 'string' && /^[0-9A-F]{6}$/i.test(data.display_id.trim())
          ? data.display_id.trim().toUpperCase()
          : '';
        const fallbackName = typeof data.val === 'string' ? data.val.trim() : '';
        const deviceName = formatDeviceDisplayName(bleService.getDeviceName(), displayId, fallbackName || canonicalId);
        if (deviceName) {
            setSettings(s => ({
                ...s,
                deviceInfo: s.deviceName || deviceName,
                deviceCanonicalId: canonicalId,
                ...(typeof data.fw === 'string' && data.fw.trim() ? { version: data.fw.trim() } : {}),
            }));
        }
    }
    const deviceNameResponseIsError = ['err', 'error'].includes(String(data.status ?? '').toLowerCase()) || data.ok === false;
    if (
        (data.cmd === 'GDN' && !deviceNameResponseIsError) ||
        (data.cmd === 'SDN' && !deviceNameResponseIsError && typeof data.val === 'string')
    ) {
        if (typeof data.val !== 'string') {
            addLog(`${data.cmd} response is missing string val`, 'error');
        } else {
            const validation = validateBleDeviceName(data.val);
            if (!validation.valid) {
                addLog(`Ignored invalid ${data.cmd} device name: ${validation.error}`, 'error');
            } else {
                setSettings(s => ({
                    ...s,
                    deviceName: data.val,
                    deviceInfo: data.val,
                    syncRevision: bumpSettingsSyncRevision(s, 'deviceName'),
                }));
            }
        }
    }
    if (data.cmd === 'GRI') {
        const power = parseFiniteNumber(data.pwr);
        setSettings(s => ({
            ...s,
            version: data.ver ?? s.version,
            ...(power !== null ? {
                power,
                syncRevision: bumpSettingsSyncRevision(s, 'power'),
            } : {}),
        }));
    }
    if (data.cmd === 'GT') setSettings(s => ({ ...s, temperature: data.val }));
    if (data.cmd === 'GB') {
        setStatus(current => current === 'connecting' ? 'connected' : current);
        const batterySnapshot = parseBatterySnapshot(data);
        if (batterySnapshot) {
            markBatteryHeartbeat();
            setSettings(s => ({ ...s, batterySnapshot }));
        } else {
            addLog('Ignored malformed GB battery response', 'error');
        }
    }
    if (isSettingsError(data)) return;
    if (data.cmd === 'GP' || data.cmd === 'SP') {
        const power = parseFiniteNumber(data.val ?? data.power ?? data.pwr);
        if (power !== null) {
            setSettings(s => ({ ...s, power, syncRevision: bumpSettingsSyncRevision(s, 'power') }));
        }
    }
    if (data.cmd === 'GLP' || data.cmd === 'SLP') {
        const profile = parseLinkProfile(data);
        if (profile !== null) {
            setSettings(s => ({ ...s, linkProfile: profile, syncRevision: bumpSettingsSyncRevision(s, 'linkProfile') }));
        }
    }
    if (data.cmd === 'GQS' || data.cmd === 'SQS') {
        let q = data.q;
        let s = data.session;
        if (q === undefined && typeof data.val === 'string') {
            const parts = data.val.split(',');
            if (parts.length >= 2) {
                q = parseInt(parts[0]);
                s = parseInt(parts[1]);
            }
        }
        if (q !== undefined && s !== undefined) {
            setSettings(prev => ({ ...prev, qValue: q, session: s, syncRevision: bumpSettingsSyncRevision(prev, 'qSession') }));
        }
    }
    if (data.cmd === 'GQP' || data.cmd === 'SQP') {
        let interval = data.interval;
        let dwell = data.dwell;
        let append = data.times ?? data.append; // Firmware sends 'times' for append value
        
        if (interval === undefined && typeof data.val === 'string') {
            const parts = data.val.split(',');
            if (parts.length >= 3) {
                interval = parseInt(parts[0]);
                dwell = parseInt(parts[1]);
                append = parseInt(parts[2]);
            }
        }
        
        if (interval !== undefined || dwell !== undefined || append !== undefined) {
            // V12.6: Firmware sends interval in ms and dwell as raw count
            const uiInterval = interval ?? 0;
            const uiDwell = dwell ?? 0;
            const uiAppend = append ?? 0;

            setSettings(prev => ({ 
                ...prev, 
                scanParams: { 
                    interval: uiInterval, 
                    dwell: uiDwell, 
                    count: uiAppend, // Legacy
                    append: uiAppend 
                },
                syncRevision: bumpSettingsSyncRevision(prev, 'queryParams'),
            }));
        }
    }
    if (data.cmd === 'GTF' || data.cmd === 'TF' || data.cmd === 'STF') {
        const reading = parseSettingReading('tag-focus', data);
        if (reading) setSettings(prev => ({ ...prev, tagFocus: reading.val === 1, syncRevision: bumpSettingsSyncRevision(prev, 'tagFocus') }));
    }
    if (data.cmd === 'GF' || data.cmd === 'SF') {
        const regionBand = parseRegionBand(data);
        if (regionBand) {
            setSettings(prev => ({ ...prev, regionBand, syncRevision: bumpSettingsSyncRevision(prev, 'regionBand') }));
        }
    }
  }, [addLog, markBatteryHeartbeat, markDeviceActivity]);

  const handleConnectionStatusChange = useCallback((nextStatus: ConnectionStatus, reason?: string) => {
    if (nextStatus === 'connecting') {
      setStatus('connecting');
      return;
    }

    if (nextStatus === 'connected') {
      const connectedAt = Date.now();
      lastBatteryHeartbeatRef.current = connectedAt;
      lastDeviceActivityRef.current = connectedAt;
      lastLiveTagsAtRef.current = null;
      // getSettings() below already queues one GB request for the reconnect.
      lastBatteryPollAtRef.current = connectedAt;
      heartbeatTimeoutReportedRef.current = false;
      setStatus('connected');
      void bleService.getSettings().catch((error: any) => {
        addLog(`State sync after reconnect failed: ${error.message}`, 'error');
      });
      return;
    }

    heartbeatTimeoutReportedRef.current = true;
    resetConnectionTracking();
    setStatus(nextStatus);
    clearDeviceTelemetry();
    if (reason) {
      addLog(reason, nextStatus === 'error' ? 'error' : 'info');
    }
  }, [addLog, clearDeviceTelemetry, resetConnectionTracking]);

  const connect = async () => {
    setStatus('connecting');
    heartbeatTimeoutReportedRef.current = false;
    const now = Date.now();
    lastBatteryHeartbeatRef.current = now;
    lastDeviceActivityRef.current = now;
    lastLiveTagsAtRef.current = null;
    lastBatteryPollAtRef.current = 0;
    inventoryActiveRef.current = false;
    inventoryModeRef.current = 'idle';
    setInventoryActiveState(false);
    setInventoryModeState('idle');
    clearDeviceTelemetry();
    try {
      await bleService.connect();
      const connectedAt = Date.now();
      lastBatteryHeartbeatRef.current = connectedAt;
      lastDeviceActivityRef.current = connectedAt;
      // The initialization sequence below explicitly requests one GB snapshot.
      lastBatteryPollAtRef.current = connectedAt;
      const identity = bleService.getDeviceIdentity();
      const deviceLabel = formatDeviceDisplayName(
        bleService.getDeviceName(),
        identity?.displayId,
        identity?.canonicalId,
      );
      if (deviceLabel) {
        setSettings(s => ({
          ...s,
          deviceInfo: deviceLabel,
          deviceCanonicalId: identity?.canonicalId ?? '',
          ...(identity?.firmware ? { version: identity.firmware } : {}),
        }));
      }
      setStatus('connected');
      addLog(`Connected to ${deviceLabel || 'NHR-10'}`, 'info');
      
      // Init Settings
      await bleService.getDeviceInfo();
      await bleService.getConfiguredDeviceName();
      await bleService.getInfo();
      lastBatteryPollAtRef.current = Date.now();
      await bleService.getBattery();
      await bleService.getPower();
      await bleService.getProfile();
      await bleService.getQSession();
      await bleService.getQueryParam();
      await bleService.getTagFocus();
      await bleService.getRegion();
      await bleService.getTemperature();

    } catch (e: any) {
      if (bleService.isIntentionalUnpairPending()) {
        addLog('Device unpair is in progress; waiting for peripheral disconnect.', 'info');
        return;
      }
      lastBatteryHeartbeatRef.current = null;
      lastDeviceActivityRef.current = null;
      lastLiveTagsAtRef.current = null;
      lastBatteryPollAtRef.current = 0;
      inventoryActiveRef.current = false;
      inventoryModeRef.current = 'idle';
      setInventoryActiveState(false);
      setInventoryModeState('idle');
      heartbeatTimeoutReportedRef.current = true;
      setStatus('error');
      clearDeviceTelemetry();
      addLog(e.message, 'error');
    }
  };

  const disconnect = () => {
    heartbeatTimeoutReportedRef.current = true;
    resetConnectionTracking();
    bleService.disconnect();
    setStatus('disconnected');
    clearDeviceTelemetry();
  };

  const getBatteryPollInterval = useCallback((): number | null => {
    const mode = inventoryModeRef.current;
    if (mode === 'batch') return BATCH_BATTERY_POLL_INTERVAL_MS;
    if (mode === 'batchSaving') return null;
    if (!inventoryActiveRef.current) return IDLE_BATTERY_POLL_INTERVAL_MS;

    const lastLiveTagsAt = lastLiveTagsAtRef.current;
    const hasRecentLiveTags = lastLiveTagsAt !== null && Date.now() - lastLiveTagsAt <= SCAN_ACTIVITY_TIMEOUT_MS;
    return hasRecentLiveTags ? SCAN_LIVE_TAGS_BATTERY_POLL_INTERVAL_MS : SCAN_NO_TAGS_BATTERY_POLL_INTERVAL_MS;
  }, []);

  // GB follows the firmware's five-second slow-filter cadence. Batch mode polls
  // less often, and batch saving suspends polling to protect the transfer path.
  useEffect(() => {
    let heartbeatPollId: number | null = null;
    let temperaturePollId: number | null = null;

    if (status === 'connected') {
      const pollBattery = () => {
        if (inventoryModeRef.current === 'batchSaving') return;
        lastBatteryPollAtRef.current = Date.now();
        void bleService.getBattery().catch(e => console.error("Battery poll failed", e));
      };

      heartbeatPollId = window.setInterval(() => {
        const batteryPollInterval = getBatteryPollInterval();
        if (batteryPollInterval !== null && Date.now() - lastBatteryPollAtRef.current >= batteryPollInterval) {
          pollBattery();
        }
      }, HEARTBEAT_CHECK_INTERVAL_MS);

      if (inventoryMode === 'idle') {
        temperaturePollId = window.setInterval(() => {
          void bleService.getTemperature().catch(e => console.error("Temp poll failed", e));
        }, TEMPERATURE_POLL_INTERVAL_MS);
      }
    }

    return () => {
      if (heartbeatPollId !== null) window.clearInterval(heartbeatPollId);
      if (temperaturePollId !== null) window.clearInterval(temperaturePollId);
    };
  }, [getBatteryPollInterval, inventoryMode, status]);

  useEffect(() => {
    if (status !== 'connected') return;

    const heartbeatCheckId = window.setInterval(() => {
      const now = Date.now();
      const mode = inventoryModeRef.current;
      if (mode === 'batchSaving') {
        return;
      }

      const lastHeartbeat = lastBatteryHeartbeatRef.current;
      const batteryTimeoutMs = mode === 'batch' ? BATCH_BATTERY_TIMEOUT_MS : IDLE_BATTERY_TIMEOUT_MS;
      if (!lastHeartbeat || now - lastHeartbeat > batteryTimeoutMs) {
        setSettings(current => {
          const snapshot = current.batterySnapshot;
          if (!snapshot || snapshot.stale) return current;
          return { ...current, batterySnapshot: { ...snapshot, stale: true } };
        });
      }

      const activityTimeoutMs = mode === 'batch' ? BATCH_BATTERY_TIMEOUT_MS : SCAN_ACTIVITY_TIMEOUT_MS;
      const lastActivity = lastDeviceActivityRef.current;
      if (!lastActivity || now - lastActivity > activityTimeoutMs) {
        const context = mode === 'batch' ? 'batch' : inventoryActiveRef.current ? 'scan' : 'idle';
        markDeviceOffline(`Device offline: no FF01 activity in ${context} mode for ${activityTimeoutMs / 1000}s`);
      }
    }, HEARTBEAT_CHECK_INTERVAL_MS);

    return () => window.clearInterval(heartbeatCheckId);
  }, [markDeviceOffline, status]);

  return {
    status,
    settings,
    setSettings,
    logs,
    addLog,
    clearLogs,
    connect,
    disconnect,
    handleConnectionStatusChange,
    setInventoryActive,
    handleDataReceived // Exported to be combined with other handlers
  };
};

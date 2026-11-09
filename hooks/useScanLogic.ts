import { useState, useRef, useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { bleService } from '../services/bleService';
import { ScanStats, Tag, ScanType, TagVisibility } from '../types';

const TAG_ACTIVE_MS = 1200;
const DEFAULT_TAG_REMOVE_MS = 3000;
const TAG_RENDER_INTERVAL_MS = 500;
const STOP_COMMAND_REPEAT_COUNT = 3;
const STOP_COMMAND_REPEAT_DELAY_MS = 120;
const SCAN_CONTROL_COMMANDS = new Set(['S', 'X', 'SB', 'XB']);

const DEFAULT_SCAN_STATS: ScanStats = {
  visibleTags: 0,
  totalReads: 0,
  readsPerSecond: 0,
  uniquePerSecond: 0,
  averageRssi: null,
  peakRssi: null,
};

export interface ScanExclusions {
  tags: Tag[];
  stats: ScanStats;
  excludeTag: (epc: string) => void;
  restoreTag: (epc: string) => void;
  restoreAll: () => void;
  clear: () => void;
}

const toFiniteNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getTagVisibility = (lastSeen: number, now: number): TagVisibility => (
  now - lastSeen <= TAG_ACTIVE_MS ? 'active' : 'stale'
);

const normalizeRemoveMs = (value: number): number => (
  Math.max(100, Math.min(60000, Math.trunc(value)))
);

const getTagFreshness = (lastSeen: number, now: number, fadeWindowMs: number): number => {
  const ageMs = now - lastSeen;
  return Math.max(0, Math.min(1, 1 - (ageMs / fadeWindowMs)));
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

const getControlStatusText = (data: any): string => (
  String(data.status ?? data.state ?? data.val ?? '').trim().toLowerCase()
);

const isSuccessfulControlResponse = (data: any): boolean => {
  if (data.err !== undefined && data.err !== 0) return false;
  const status = getControlStatusText(data);
  if (!status) return true;
  return ['ok', 'started', 'stopped', 'saved', 'done', 'idle'].includes(status);
};

const isControlErrorResponse = (data: any): boolean => {
  if (data.err !== undefined && data.err !== 0) return true;
  const status = getControlStatusText(data);
  return status.includes('fail') || status.includes('error') || status.includes('denied');
};

export const useScanLogic = (addLog: (msg: string, type: 'info' | 'error' | 'rx' | 'tx') => void) => {
  const [isScanning, setIsScanning] = useState(false);
  const [activeScanType, setActiveScanType] = useState<ScanType>(null);
  const [scanStartedAt, setScanStartedAt] = useState<number | null>(null);
  const [scanStoppedAt, setScanStoppedAt] = useState<number | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [stats, setStats] = useState<ScanStats>(DEFAULT_SCAN_STATS);
  const [excludedTags, setExcludedTags] = useState<Tag[]>([]);
  const [excludedStats, setExcludedStats] = useState<ScanStats>(DEFAULT_SCAN_STATS);
  const excludedEpcsRef = useRef(new Set<string>());
  // Keep the inventory complete by default. Stale-tag hiding is an opt-in display filter.
  const [removeStaleTags, setRemoveStaleTags] = useState(false);
  const [staleRemoveMs, setStaleRemoveMsState] = useState(DEFAULT_TAG_REMOVE_MS);
  const tagsMap = useRef<Map<string, Tag>>(new Map());
  const rafRef = useRef<number | null>(null);
  const publishTimerRef = useRef<number | null>(null);
  const lastPublishAtRef = useRef(0);
  // Keep device counters across a display clear so the next cumulative count
  // contributes only new reads. A new reader scan resets these baselines.
  const deviceCountsRef = useRef(new Map<string, number>());
  const windowReadsRef = useRef(new Map<string, number>());
  const windowUniqueRef = useRef(new Set<string>());
  const ratesRef = useRef(new Map<string, { reads: number; unique: number }>());
  const statsLastAtRef = useRef(Date.now());
  const isScanningRef = useRef(false);
  const activeScanTypeRef = useRef<ScanType>(null);
  const stopRequestedRef = useRef(true);
  const stopInFlightRef = useRef(false);

  const resetScanData = useCallback(() => {
    const now = Date.now();
    tagsMap.current.clear();
    deviceCountsRef.current.clear();
    windowReadsRef.current.clear();
    windowUniqueRef.current.clear();
    ratesRef.current.clear();
    lastPublishAtRef.current = 0;
    statsLastAtRef.current = now;
    setTags([]);
    setStats(DEFAULT_SCAN_STATS);
    setExcludedTags(Array.from(excludedEpcsRef.current, epc => ({ epc, timestamp: 0, count: 0 })));
    setExcludedStats(DEFAULT_SCAN_STATS);
  }, []);

  const resetScanSession = useCallback(() => {
    stopRequestedRef.current = true;
    isScanningRef.current = false;
    activeScanTypeRef.current = null;
    resetScanData();
    setIsScanning(false);
    setActiveScanType(null);
    setScanStartedAt(null);
    setScanStoppedAt(null);
  }, [resetScanData]);

  const applyDeviceScanStarted = useCallback((mode: Exclude<ScanType, null>) => {
    const shouldStartNewSession = !isScanningRef.current || activeScanTypeRef.current !== mode;
    const startedAt = Date.now();

    if (shouldStartNewSession) {
      resetScanData();
    }

    stopRequestedRef.current = false;
    stopInFlightRef.current = false;
    isScanningRef.current = true;
    activeScanTypeRef.current = mode;

    if (mode === 'interactive') {
      bleService.resumeLiveTags();
    } else {
      bleService.suspendLiveTags();
    }

    setIsScanning(true);
    setActiveScanType(mode);
    setScanStartedAt((current) => shouldStartNewSession ? startedAt : current ?? startedAt);
    setScanStoppedAt(null);
  }, [resetScanData]);

  const applyDeviceScanStopped = useCallback(() => {
    const stoppedAt = Date.now();

    stopRequestedRef.current = true;
    stopInFlightRef.current = false;
    isScanningRef.current = false;
    activeScanTypeRef.current = null;
    bleService.suspendLiveTags();
    windowReadsRef.current.clear();
    windowUniqueRef.current.clear();
    ratesRef.current.clear();

    flushSync(() => {
      setIsScanning(false);
      setActiveScanType(null);
      setScanStoppedAt(stoppedAt);
      setStats(current => ({ ...current, readsPerSecond: 0, uniquePerSecond: 0 }));
      setExcludedStats(current => ({ ...current, readsPerSecond: 0, uniquePerSecond: 0 }));
    });
  }, []);

  const setStaleRemoveMs = useCallback((value: number) => {
    setStaleRemoveMsState(normalizeRemoveMs(value));
  }, []);

  const publishVisibleTags = useCallback((sampleRates = true) => {
    const now = Date.now();
    const fadeWindowMs = normalizeRemoveMs(staleRemoveMs);
    const visibleTags: Tag[] = [];
    const liveInventory: Tag[] = [];
    const trackedTags: Tag[] = [];
    let visibleLiveCount = 0;

    if (sampleRates) {
      const elapsedSeconds = Math.max(0.001, (now - statsLastAtRef.current) / 1000);
      ratesRef.current.clear();
      if (isScanningRef.current) {
        for (const [epc, reads] of windowReadsRef.current) {
          ratesRef.current.set(epc, {
            reads: reads / elapsedSeconds,
            unique: windowUniqueRef.current.has(epc) ? 1 / elapsedSeconds : 0,
          });
        }
      }
      windowReadsRef.current.clear();
      windowUniqueRef.current.clear();
      statsLastAtRef.current = now;
    }

    for (const tag of tagsMap.current.values()) {
      const lastSeen = tag.lastSeen ?? tag.timestamp;
      const snapshot = {
        ...tag,
        visibility: getTagVisibility(lastSeen, now),
        freshness: getTagFreshness(lastSeen, now, fadeWindowMs),
      };
      const visible = !removeStaleTags || now - lastSeen <= fadeWindowMs;
      if (visible) visibleTags.push(snapshot);
      if (!excludedEpcsRef.current.has(tag.epc)) {
        liveInventory.push(snapshot);
        if (visible) visibleLiveCount++;
      }
    }

    // Membership survives clears, stale filters and new scans; measurements do not.
    for (const epc of excludedEpcsRef.current) {
      const tag = tagsMap.current.get(epc);
      trackedTags.push(tag ? {
        ...tag,
        visibility: getTagVisibility(tag.lastSeen ?? tag.timestamp, now),
        freshness: getTagFreshness(tag.lastSeen ?? tag.timestamp, now, fadeWindowMs),
      } : { epc, timestamp: 0, count: 0 });
    }

    const summarize = (inventory: Tag[], visibleCount: number): ScanStats => {
      const result = { ...DEFAULT_SCAN_STATS, visibleTags: visibleCount };
      let rssiSum = 0;
      let rssiCount = 0;
      for (const tag of inventory) {
        result.totalReads += tag.count;
        const rates = ratesRef.current.get(tag.epc);
        result.readsPerSecond += rates?.reads ?? 0;
        result.uniquePerSecond += rates?.unique ?? 0;
        const rssi = tag.lastRssi ?? tag.rssi;
        if (typeof rssi === 'number' && Number.isFinite(rssi)) {
          rssiSum += rssi;
          rssiCount++;
          result.peakRssi = result.peakRssi === null ? rssi : Math.max(result.peakRssi, rssi);
        }
      }
      result.averageRssi = rssiCount ? rssiSum / rssiCount : null;
      return result;
    };

    setTags(visibleTags);
    setStats(summarize(liveInventory, visibleLiveCount));
    setExcludedTags(trackedTags);
    setExcludedStats(summarize(trackedTags, trackedTags.filter(tag => tag.count > 0).length));
    lastPublishAtRef.current = now;
  }, [removeStaleTags, staleRemoveMs]);

  const requestPublish = useCallback(() => {
    if (rafRef.current !== null || publishTimerRef.current !== null) return;

    const elapsed = Date.now() - lastPublishAtRef.current;
    const delay = Math.max(0, TAG_RENDER_INTERVAL_MS - elapsed);

    const runPublish = () => {
      publishTimerRef.current = null;
      rafRef.current = requestAnimationFrame(() => {
        publishVisibleTags();
        rafRef.current = null;
      });
    };

    if (delay === 0) {
      runPublish();
      return;
    }

    if (publishTimerRef.current === null) {
      publishTimerRef.current = window.setTimeout(runPublish, delay);
    }
  }, [publishVisibleTags]);

  const excludeTag = useCallback((epc: string) => {
    if (!tagsMap.current.has(epc)) return;
    excludedEpcsRef.current.add(epc);
    publishVisibleTags(false);
  }, [publishVisibleTags]);

  const restoreTag = useCallback((epc: string) => {
    excludedEpcsRef.current.delete(epc);
    publishVisibleTags(false);
  }, [publishVisibleTags]);

  const restoreAll = useCallback(() => {
    excludedEpcsRef.current.clear();
    publishVisibleTags(false);
  }, [publishVisibleTags]);

  const clearGroup = useCallback((excluded: boolean) => {
    for (const epc of tagsMap.current.keys()) {
      if (excludedEpcsRef.current.has(epc) !== excluded) continue;
      tagsMap.current.delete(epc);
      windowReadsRef.current.delete(epc);
      windowUniqueRef.current.delete(epc);
      ratesRef.current.delete(epc);
    }
    publishVisibleTags(false);
  }, [publishVisibleTags]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (tagsMap.current.size > 0) {
        requestPublish();
      }
    }, TAG_RENDER_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      if (publishTimerRef.current !== null) {
        window.clearTimeout(publishTimerRef.current);
        publishTimerRef.current = null;
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [requestPublish]);

  const handleDataReceived = useCallback((data: any) => {
    if (SCAN_CONTROL_COMMANDS.has(data.cmd)) {
      if (isControlErrorResponse(data)) {
        addLog(`${data.cmd} failed: ${data.err ?? data.status ?? data.state ?? 'Unknown error'}`, 'error');
        return;
      }

      if (!isSuccessfulControlResponse(data)) {
        return;
      }

      if (data.cmd === 'S') {
        applyDeviceScanStarted('interactive');
      } else if (data.cmd === 'SB') {
        applyDeviceScanStarted('batch');
      } else if (data.cmd === 'X' || data.cmd === 'XB') {
        applyDeviceScanStopped();
      }

      return;
    }

    if (stopRequestedRef.current || !isScanningRef.current) {
      return;
    }

    if (data.cmd !== 'live_tags' || !Array.isArray(data.d)) {
      return;
    }

    const now = Date.now();
    let hasChanges = false;

    data.d.forEach((item: unknown) => {
      if (!Array.isArray(item) || item.length < 4) return;

      const [rawEpc, rawRssi, rawDelta, rawTotal] = item;
      const epc = typeof rawEpc === 'string' ? rawEpc.trim() : '';
      const rssi = toFiniteNumber(rawRssi);
      const countDelta = toFiniteNumber(rawDelta);
      const totalCount = toFiniteNumber(rawTotal);

      if (!epc || rssi === null || countDelta === null || totalCount === null) {
        return;
      }

      const safeCountDelta = Math.max(0, Math.trunc(countDelta));
      const deviceCount = Math.max(0, Math.trunc(totalCount));
      const previousDeviceCount = deviceCountsRef.current.get(epc);
      const newReads = previousDeviceCount === undefined ? deviceCount
        : deviceCount >= previousDeviceCount ? deviceCount - previousDeviceCount : safeCountDelta;
      deviceCountsRef.current.set(epc, deviceCount);
      if (newReads === 0) return;

      const existingTag = tagsMap.current.get(epc);
      const tag = existingTag ? { ...existingTag } : {
        epc,
        timestamp: now,
        firstSeen: now,
        count: 0,
      };
      tag.count += newReads;
      tag.delta = newReads;
      tag.lastRssi = rssi;
      tag.rssi = rssi;
      tag.lastSeen = now;
      tag.timestamp = now;
      tag.firstSeen = tag.firstSeen ?? now;
      tag.freshness = 1;
      tag.visibility = 'active';

      tagsMap.current.set(epc, tag);
      windowReadsRef.current.set(epc, (windowReadsRef.current.get(epc) ?? 0) + newReads);
      if (!existingTag) {
        windowUniqueRef.current.add(epc);
      }
      hasChanges = true;
    });

    if (hasChanges) {
      requestPublish();
    }
  }, [addLog, applyDeviceScanStarted, applyDeviceScanStopped, requestPublish]);

  const startScan = async () => {
    try {
      stopRequestedRef.current = true;
      isScanningRef.current = false;
      activeScanTypeRef.current = null;
      resetScanData();
      setScanStartedAt(null);
      setScanStoppedAt(null);
      await bleService.startScan();
      applyDeviceScanStarted('interactive');
      addLog('Scanning Started', 'info');
    } catch (e: any) {
      stopRequestedRef.current = true;
      isScanningRef.current = false;
      activeScanTypeRef.current = null;
      addLog(e.message, 'error');
    }
  };

  const stopScan = async () => {
    const stopType = activeScanTypeRef.current ?? activeScanType;
    const wasScanning = isScanningRef.current || isScanning || stopType !== null;
    if (stopInFlightRef.current) {
      return;
    }

    if (!wasScanning) {
      stopRequestedRef.current = true;
      isScanningRef.current = false;
      activeScanTypeRef.current = null;
      return;
    }

    const stoppedAt = Date.now();
    stopInFlightRef.current = true;
    applyDeviceScanStopped();
    stopInFlightRef.current = true;
    setScanStoppedAt(stoppedAt);

    const sendInteractiveStopBurst = async () => {
      let success = false;
      let lastError: any = null;

      for (let attempt = 0; attempt < STOP_COMMAND_REPEAT_COUNT; attempt++) {
        try {
          await bleService.stopScan();
          success = true;
        } catch (error: any) {
          lastError = error;
        }

        if (attempt < STOP_COMMAND_REPEAT_COUNT - 1) {
          await wait(STOP_COMMAND_REPEAT_DELAY_MS);
        }
      }

      if (!success) {
        throw lastError ?? new Error('Stop command failed');
      }
    };

    const sendBatchStopBurst = async () => {
      let success = false;
      let lastError: any = null;

      for (let attempt = 0; attempt < STOP_COMMAND_REPEAT_COUNT; attempt++) {
        try {
          await bleService.stopBatch();
          success = true;
        } catch (error: any) {
          lastError = error;
        }

        if (attempt < STOP_COMMAND_REPEAT_COUNT - 1) {
          await wait(STOP_COMMAND_REPEAT_DELAY_MS);
        }
      }

      if (!success) {
        throw lastError ?? new Error('Stop batch command failed');
      }
    };

    const sendStopCommand = async () => {
      if (stopType === 'batch') {
        await sendBatchStopBurst();
        return;
      }

      await sendInteractiveStopBurst();
    };

    try {
      await sendStopCommand();
      addLog(stopType === 'batch' ? 'Batch Mode Stopped' : 'Scanning Stopped', 'info');
    } catch (error: any) {
      addLog(`Stop command failed: ${error?.message ?? 'Unknown error'}`, 'error');
    } finally {
      stopInFlightRef.current = false;
    }
  };

  const startBatch = async () => {
    try {
      stopRequestedRef.current = true;
      isScanningRef.current = false;
      activeScanTypeRef.current = null;
      resetScanData();
      setScanStartedAt(null);
      setScanStoppedAt(null);
      await bleService.startBatch();
      applyDeviceScanStarted('batch');
      addLog('Batch Mode Started', 'info');
    } catch (e: any) {
      stopRequestedRef.current = true;
      isScanningRef.current = false;
      activeScanTypeRef.current = null;
      addLog(e.message, 'error');
    }
  };

  const clearTags = () => {
    clearGroup(false);
  };

  return {
    isScanning,
    activeScanType,
    scanStartedAt,
    scanStoppedAt,
    removeStaleTags,
    staleRemoveMs,
    tags,
    stats,
    exclusions: {
      tags: excludedTags,
      stats: excludedStats,
      excludeTag,
      restoreTag,
      restoreAll,
      clear: () => clearGroup(true),
    } satisfies ScanExclusions,
    setRemoveStaleTags,
    setStaleRemoveMs,
    startScan,
    stopScan,
    startBatch,
    clearTags,
    resetScanSession,
    handleDataReceived
  };
};

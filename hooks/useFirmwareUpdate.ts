import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FirmwareUpdateService } from '../services/firmwareUpdateService';
import { MAX_OTA_IMAGE_SIZE, OtaPackage, parsePackage } from '../services/otaPackage';
import { fetchApprovedRelease, firmwareReleaseUrl } from '../services/otaRelease';
import { OtaInfo, OtaTransportKind } from '../services/otaProtocol';

interface Coordination { assertIdle(): void; pause(): void; resume(connected: boolean, info?: OtaInfo): void }
export function useFirmwareUpdate(coordination: Coordination) {
  const [service] = useState(() => new FirmwareUpdateService());
  const state = useSyncExternalStore(service.subscribe, service.snapshot);
  const context = useRef(coordination); context.current = coordination;
  const [pkg, setPackage] = useState<OtaPackage | null>(null);
  const [loading, setLoading] = useState(false);
  const [packageError, setPackageError] = useState('');
  const selection = useRef(0);
  const load = async (work: () => Promise<OtaPackage>) => {
    if (service.state.active) return;
    const generation = ++selection.current;
    service.reset();
    setLoading(true); setPackage(null); setPackageError('');
    try { const result = await work(); if (selection.current === generation) setPackage(result); }
    catch (error) { if (selection.current === generation) setPackageError((error as Error).message); }
    finally { if (selection.current === generation) setLoading(false); }
  };
  useEffect(() => () => { ++selection.current; void service.cancel(); }, [service]);
  useEffect(() => {
    if (!state.active) return;
    let disposed = false;
    let wake: { release(): Promise<void>; released: boolean } | undefined;
    const requestWake = async () => {
      if (document.visibilityState !== 'visible' || (wake && !wake.released)) return;
      try {
        const lock = await navigator.wakeLock?.request('screen');
        if (disposed) await lock?.release(); else wake = lock;
      } catch { service.log('wake-lock-unavailable'); }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const visibility = () => { service.log('visibility', { state: document.visibilityState }); void requestWake(); };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', visibility);
    void requestWake();
    return () => {
      disposed = true; void wake?.release().catch(() => undefined);
      window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('visibilitychange', visibility);
    };
  }, [service, state.active]);
  const clearPackage = () => {
    if (service.state.active) return;
    service.reset();
    ++selection.current; setPackage(null); setPackageError(''); setLoading(false);
  };
  return {
    state, pkg, loading, packageError, releaseConfigured: !!firmwareReleaseUrl,
    isActive: () => service.state.active,
    clearPackage,
    selectFile: (file: File) => load(async () => {
      if (!/\.nhrota$/i.test(file.name)) throw new Error('Select a .nhrota firmware package. BIN and ZIP files are not supported.');
      if (file.size > MAX_OTA_IMAGE_SIZE + 108) throw new Error('Package exceeds the 3 MiB image limit.');
      return parsePackage(await file.arrayBuffer(), file.name);
    }),
    loadRelease: () => load(fetchApprovedRelease),
    prepare: (transport: OtaTransportKind, allowDowngrade: boolean) => {
      if (!pkg || loading) return Promise.resolve();
      return service.prepare(pkg, transport, allowDowngrade, {
        assertIdle: () => context.current.assertIdle(), pause: () => context.current.pause(), resume: (connected, info) => context.current.resume(connected, info),
      });
    },
    install: () => service.install(),
    cancel: () => service.cancel(),
    downloadDiagnostics: () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(service.diagnostics(), null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `nhr10_ota_${Date.now()}.json`;
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    },
  };
}
export type FirmwareUpdate = ReturnType<typeof useFirmwareUpdate>;

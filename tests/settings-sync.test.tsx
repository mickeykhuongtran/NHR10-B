import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useRFIDConnection } from '../hooks/useRFIDConnection';

vi.mock('../services/bleService', () => ({ bleService: {} }));
it('does not turn Tag Focus off on a status-only ACK, missing value or device error', () => {
  let connection!: ReturnType<typeof useRFIDConnection>;
  function Harness() { connection = useRFIDConnection(); return null; }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Harness />));
  try {
    act(() => connection.handleDataReceived({ cmd: 'GTF', val: 1 }));
    const revision = connection.settings.syncRevision?.tagFocus;
    for (const data of [{ cmd: 'TF', status: 'ok' }, { cmd: 'GTF', status: 'err', val: 0 }, { cmd: 'GTF', val: 'bad' }]) {
      act(() => connection.handleDataReceived(data));
      expect(connection.settings.tagFocus).toBe(true); expect(connection.settings.syncRevision?.tagFocus).toBe(revision);
    }
    act(() => connection.handleDataReceived({ cmd: 'GTF', val: 0 })); expect(connection.settings.tagFocus).toBe(false);
  } finally { act(() => root.unmount()); }
});

it('stores profile and format together and invalidates cached data across connection changes', () => {
  let connection!: ReturnType<typeof useRFIDConnection>;
  function Harness() { connection = useRFIDConnection(); return null; }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Harness />));
  try {
    expect(connection.settings.linkProfile).toBeNull();
    act(() => connection.handleDataReceived({ cmd: 'GLP', val: 15, format: 2 }));
    expect(connection.settings).toMatchObject({ linkProfile: 15, linkProfileFormat: 2, linkProfileConfirmed: true });
    act(() => connection.handleConnectionStatusChange('disconnected'));
    expect(connection.settings).toMatchObject({ linkProfile: 15, linkProfileFormat: null, linkProfileConfirmed: false });
    act(() => connection.handleDataReceived({ cmd: 'GLP', val: 65535 }));
    expect(connection.settings).toMatchObject({ linkProfile: 65535, linkProfileFormat: null, linkProfileConfirmed: true });
    for (const val of [-1, 65536, 1.5, 'bad']) act(() => connection.handleDataReceived({ cmd: 'GLP', val, format: 2 }));
    expect(connection.settings).toMatchObject({ linkProfile: 65535, linkProfileFormat: null });
    act(() => connection.handleDataReceived({ cmd: 'SLP', status: 'err', error: 'persist_failed', val: 13 }));
    expect(connection.settings).toMatchObject({ linkProfile: 65535, linkProfileConfirmed: false });
    act(() => connection.handleDataReceived({ cmd: 'GRP', val: '5185,6,255,0', format: 2 }));
    expect(connection.settings).toMatchObject({ linkProfile: 5185, linkProfileFormat: 2, linkProfileConfirmed: true, qValue: 6, session: 255, target: 0 });
  } finally { act(() => root.unmount()); }
});

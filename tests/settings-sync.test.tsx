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

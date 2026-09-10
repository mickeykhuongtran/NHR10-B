import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { batteryView, parseBatterySnapshot } from '../utils/battery';
import { BatteryIndicator } from '../components/ui/BatteryIndicator';

const packet = {
  cmd: 'GB', voltage: 7500, state: 'NORMAL', load: 'load', ver: 2,
  percent: 61.3, valid: true, charging: false, full: false, health: 0, age_ms: 200,
};
const parse = (overrides: Record<string, unknown> = {}) => parseBatterySnapshot({ ...packet, ...overrides }, 0)!;
const view = (overrides: Record<string, unknown> = {}) => batteryView(parse(overrides), { now: 0 });

describe('GB v2 display contract', () => {
  it('takes percentage directly from firmware regardless of RF load or voltage', () => {
    for (const voltage of [0, 5800, 7500, 8200, 8400, 9500]) {
      for (const load of ['idle', 'load']) expect(view({ voltage, load }).text).toBe('61.3%');
    }
    expect(view({ percent: 99.9 }).text).toBe('99.9%');
    expect(view({ percent: 0 }).text).toBe('0.0%');
    expect(view({ percent: 0 }).fillPercent).toBe(0);
    expect(view({ percent: 0 }).status).toBe('NORMAL'); // Protection is independent of SOC.
    expect(parse({ voltage: 0 }).voltageMv).toBe(0);
  });

  it.each([null, undefined, '61.3', false, -1, 101, NaN, Infinity])('rejects invalid percent %s without coercion', percent => {
    expect(view({ percent })).toMatchObject({ text: '—', percent: null, fillPercent: null, full: false });
  });

  it.each([
    { valid: false }, { valid: 'true' }, { age_ms: 3001 }, { age_ms: null },
    { age_ms: -1 }, { age_ms: 0xffffffff }, { age_ms: 0x100000000 },
    { age_ms: '200' }, { health: null }, { health: 256 }, { health: -1 }, { health: 1.5 }, { health: '0' },
  ])('rejects unavailable estimates: %j', overrides => {
    expect(view(overrides).percent).toBeNull();
  });

  it.each([
    [{ state: 'CRITICAL', health: 7 }, 'CRITICAL'],
    [{ health: 7 }, 'HIGH VOLT'], [{ health: 6 }, 'CHG FAULT'],
    [{ health: 4 }, 'ADC CHECK'], [{ health: 8 }, 'BATTERY FAULT'],
    [{ health: 128 }, 'BATTERY FAULT'], [{ state: 'WARNING' }, 'WARNING'],
  ])('prioritizes protection and health over full/charging: %j', (overrides, status) => {
    expect(view({ percent: 100, full: true, charging: true, ...overrides })).toMatchObject({ status, full: false });
  });

  it('requires confirmed full; STAT false/null and 100% alone do not mean full', () => {
    expect(view({ percent: 100, full: true }).status).toBe('FULL');
    expect(view({ percent: 99.9, full: true }).full).toBe(false);
    expect(view({ percent: 100, full: false }).status).toBe('NORMAL');
    expect(view({ percent: 100, charging: false }).full).toBe(false);
    expect(view({ charging: null }).charging).toBeNull();
    expect(view({ charging: true }).status).toBe('CHARGING');
    expect(view({ charging: true, health: 2 }).charging).toBeNull();
  });

  it('expires without notifications, clears charging/full and accounts for ADC age', () => {
    const full = parse({ percent: 100, full: true, charging: true, age_ms: 0 });
    expect(batteryView(full, { now: 14999 }).status).toBe('FULL');
    expect(batteryView(full, { now: 15000 })).toMatchObject({ status: 'STALE', text: '—', charging: null, full: false });
    expect(batteryView(parse({ age_ms: 3000 }), { now: 12001 }).status).toBe('STALE');
    expect(batteryView(full, { connected: false, now: 0 })).toMatchObject({ status: 'DISCONNECTED', text: '—', charging: null, full: false });
  });

  it('shows boot/no-calibration/invalid snapshots without keeping a previous percentage', () => {
    expect(view({ voltage: 0, percent: null, valid: false, age_ms: 0xffffffff }).status).toBe('CHECKING');
    expect(view({ voltage: 0, percent: null, valid: false, age_ms: 0xffffffff, health: 4 }).status).toBe('ADC CHECK');
    expect(view({ health: 4 }).percent).toBeNull();
  });

  it('retains supported shutdown at zero until disconnect, even with old ADC data', () => {
    for (const ver of [2, undefined]) {
      const shutdown = parse({ ver, state: 'ShUtDoWn', percent: 0, age_ms: 20000 });
      expect(batteryView(shutdown, { now: 90000 })).toMatchObject({ status: 'SHUTDOWN', text: '0.0%', charging: null, full: false });
      expect(batteryView(shutdown, { connected: false, now: 90000 }).text).toBe('—');
    }
    expect(view({ ver: 3, state: 'shutdown' }).status).toBe('UNSUPPORTED VERSION');
  });

  it('keeps legacy diagnostics and explicitly rejects unsupported versions', () => {
    const legacy = parseBatterySnapshot({ cmd: 'GB', voltage: 7896, state: 'NORMAL', load: 'idle' }, 0)!;
    expect(legacy).toMatchObject({ voltageMv: 7896, protectionState: 'normal', legacy: true, percent: null });
    expect(batteryView(legacy, { now: 0 })).toMatchObject({ text: '—', status: 'UPDATE FIRMWARE' });
    for (const ver of [1, 3, null, '2']) expect(view({ ver }).status).toBe('UNSUPPORTED VERSION');
    expect(view({ state: 'WARNING', ver: undefined })).toMatchObject({ status: 'WARNING', percent: null });
    expect(parseBatterySnapshot({ cmd: 'live_tags' })).toBeNull();
    expect(parseBatterySnapshot(null)).toBeNull();
  });
});

it('renders exact fill, unknown state and health labels in the shared battery indicator', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (overrides: Record<string, unknown>, connected = true) => act(() => root.render(
    <BatteryIndicator snapshot={parseBatterySnapshot({ ...packet, ...overrides })} connected={connected} />,
  ));
  try {
    render({ percent: 99.9 });
    expect(container.textContent).toBe('99.9%');
    expect(container.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('99.9');
    render({ percent: null, valid: false });
    expect(container.textContent).toContain('—');
    expect(container.querySelector('[role="meter"]')?.hasAttribute('aria-valuenow')).toBe(false);
    render({ percent: 100, full: true, health: 1, charging: true });
    expect(container.textContent).toContain('HIGH VOLT');
    expect(container.textContent).not.toContain('FULL');
    expect(container.querySelector('[aria-label="Charging"]')).toBeNull();
    render({ percent: 100, full: true }, false);
    expect(container.textContent).toBe('—DISCONNECTED');
  } finally { act(() => root.unmount()); }
});

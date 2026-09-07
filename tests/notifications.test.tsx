import React, { act, StrictMode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNotifications } from '../hooks/useNotifications';
import { LogEntry } from '../types';

let root: Root;
let container: HTMLDivElement;
const entry = (message: string, type: LogEntry['type'] = 'info', timestamp = Date.now()): LogEntry => ({ message, type, timestamp });
function Harness({ logs }: { logs: LogEntry[] }) {
  const { notice, dismiss } = useNotifications(logs);
  return <><p>{notice?.message}</p><button onClick={dismiss}>Dismiss</button></>;
}
const render = (logs: LogEntry[]) => act(() => root.render(<StrictMode><Harness logs={logs} /></StrictMode>));
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const text = () => container.querySelector('p')?.textContent;

beforeEach(() => { vi.useFakeTimers(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe('Notification lifetime under BLE traffic', () => {
  it('expires after 4.2 s even with continuously arriving telemetry', () => {
    let logs = [entry('Connected to NHR10-TEST')];
    render(logs);
    for (let i = 0; i < 40; i++) {
      advance(100);
      logs = [...logs, entry('GB voltage=7900', 'rx')]; render(logs);
    }
    expect(text()).toBe('Connected to NHR10-TEST');
    advance(201); expect(text()).toBe('');
    render([...logs, entry('GB next sample', 'rx')]); expect(text()).toBe('');
  });
  it('keeps errors for 6.5 s, then expires', () => {
    render([entry('Connection failed', 'error')]); advance(6499);
    expect(text()).toBe('Connection failed'); advance(1); expect(text()).toBe('');
  });
  it('ignores raw TX/RX even when their payload contains saved or failed', () => {
    render([entry('RX saved', 'rx'), entry('TX reconnect', 'tx')]); expect(text()).toBe('');
  });
  it('gives a genuinely new notice its own deadline', () => {
    const first = entry('Connected'); render([first]); advance(3000);
    render([first, entry('Configuration saved')]); advance(1201);
    expect(text()).toBe('Configuration saved'); advance(3000); expect(text()).toBe('');
  });
  it('does not resurrect manually dismissed notices on the next log update', () => {
    const first = entry('Connected'); render([first]);
    act(() => container.querySelector('button')!.click());
    render([first, entry('New telemetry', 'rx')]); expect(text()).toBe('');
  });
  it('does not pin repeated identical failures', () => {
    let logs = [entry('Reconnect failed', 'error')]; render(logs);
    for (let i = 0; i < 7; i++) { advance(1000); logs = [...logs, entry('Reconnect failed', 'error')]; render(logs); }
    expect(text()).toBe('');
  });
  it('distinguishes separate events with the same millisecond timestamp', () => {
    const first = entry('Connected', 'info', 123); render([first]);
    render([first, entry('Write failed', 'error', 123)]); expect(text()).toBe('Write failed');
  });
  it('cleans up timers when unmounted', () => {
    render([entry('Connected')]); act(() => root.render(null)); expect(vi.getTimerCount()).toBe(0);
  });
});

it('shows identical write outcomes for distinct attempts and expires each one', () => {
  const first = { ...entry('The reader confirmed the write.'), notice: { id: 'write-1', title: 'Write confirmed' } };
  render([first]); advance(4200); expect(text()).toBe('');
  const second = { ...entry(first.message), notice: { id: 'write-2', title: 'Write confirmed' } };
  render([first, second]); expect(text()).toBe(first.message);
  advance(4200); expect(text()).toBe('');
});

import { useCallback, useEffect, useRef, useState } from 'react';
import { LogEntry } from '../types';

export const NOTICE_DURATION_MS = 4200;
export const ERROR_DURATION_MS = 6500;

export const isUserNotice = (entry: LogEntry) => entry.type === 'error' || (
  entry.type === 'info' && (Boolean(entry.notice) || /connected|disconnect|reconnect|saved|success|failed|offline|popup sent|updated|applied/i.test(entry.message))
);

/** Log traffic must never own or cancel the lifetime of a visible notification. */
export function useNotifications(logs: LogEntry[]) {
  const [notice, setNotice] = useState<LogEntry | null>(null);
  const seen = useRef(new WeakSet<LogEntry>());
  const lastMessage = useRef({ key: '', at: 0 });

  useEffect(() => {
    let latest: LogEntry | null = null;
    for (const entry of logs) {
      if (seen.current.has(entry)) continue;
      seen.current.add(entry);
      if (isUserNotice(entry)) latest = entry;
    }
    if (!latest) return;
    // Each intentional write attempt gets feedback, even when its result repeats.
    const key = latest.notice?.id ?? `${latest.type}:${latest.message}`;
    // Repeated reconnect/errors must not pin a toast to the screen either.
    if (lastMessage.current.key === key && Date.now() - lastMessage.current.at < 10000) return;
    lastMessage.current = { key, at: Date.now() };
    setNotice(latest);
  }, [logs]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null),
      notice.type === 'error' ? ERROR_DURATION_MS : NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const dismiss = useCallback(() => setNotice(null), []);
  return { notice, dismiss };
}

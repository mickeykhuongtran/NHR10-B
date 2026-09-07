import React from 'react';
import { X } from 'lucide-react';
import { LogEntry } from '../../types';
import { ERROR_DURATION_MS, NOTICE_DURATION_MS } from '../../hooks/useNotifications';

export function Notification({ notice, onDismiss }: { notice: LogEntry | null; onDismiss: () => void }) {
  return (
    <div className="notification-region" aria-live="polite" aria-atomic="true">
      {notice && (
        <div className={`notification ${notice.type === 'error' ? 'notification-error' : ''}`} key={notice.notice?.id ?? `${notice.timestamp}:${notice.message}`}>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{notice.notice?.title ?? (notice.type === 'error' ? 'Action needs attention' : 'Device update')}</p>
            <p className="mt-1 break-words text-sm text-slate-600">{notice.message}</p>
          </div>
          <button type="button" className="notification-close" onClick={onDismiss} aria-label="Dismiss notification"><X size={16} /></button>
          <span className="notification-timer" aria-hidden="true" style={{ animationDuration: `${notice.type === 'error' ? ERROR_DURATION_MS : NOTICE_DURATION_MS}ms` }} />
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import AutoSizer from 'react-virtualized-auto-sizer';
import { FixedSizeList as List } from 'react-window';
import { Button } from '../ui/Button';
import { BatchHistoryRecord, BatchSaveInfo, FileTransferStatus } from '../../types';
import { PageHeader } from './PageHeader';

interface HistoryTabProps {
  isConnected: boolean;
  isBusy: boolean;
  onConnect: () => void;
  onFetchHistory: () => void;
  onDownloadJson: () => void;
  onDownloadCsv: () => void;
  onDownloadTxt: () => void;
  onShare: () => void;
  onClearFileData: () => void;
  isFileTransferring: boolean;
  transferProgress: number;
  transferStatus: FileTransferStatus;
  isBatchSaving: boolean;
  batchSaveInfo: BatchSaveInfo;
  historyData: BatchHistoryRecord[];
}

export const HistoryTab: React.FC<HistoryTabProps> = (props) => {
  const [shareNotice, setShareNotice] = useState('');
  const hasData = props.historyData.length > 0;
  const saving = props.isBatchSaving || props.transferStatus === 'saving';
  const progress = Math.max(0, Math.min(100, saving ? props.batchSaveInfo.progress : props.transferProgress));
  const busy = saving || props.isBusy || props.isFileTransferring;
  const supported = 'bluetooth' in navigator && window.isSecureContext;
  const transferCopy: Record<FileTransferStatus, string> = {
    idle: 'Ready to retrieve saved data', requesting: 'Requesting saved data…', saving: 'The reader is saving your batch…', transferring: 'Downloading from the reader…', parsing: 'Checking data integrity…', complete: 'Download complete', error: 'Download failed. Reconnect or check Diagnostics, then try again.',
  };
  useEffect(() => {
    if (!shareNotice) return;
    const timer = window.setTimeout(() => setShareNotice(''), 4200);
    return () => window.clearTimeout(timer);
  }, [shareNotice]);
  const share = async () => {
    const data = { title: 'NHR-10 batch inventory', text: props.historyData.map(row => `${row.INDEX}. ${row.EPC}`).join('\n') };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(data.text); setShareNotice('Batch data copied to clipboard.'); }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) setShareNotice('Sharing is unavailable. Export the data as CSV, TXT, or JSON.');
    }
  };
  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => <div style={style} role="row" className="grid grid-cols-[70px_minmax(240px,1fr)] items-center border-b border-slate-100 px-5 text-sm hover:bg-slate-50"><span role="cell" className="text-slate-400">{props.historyData[index].INDEX}</span><span role="cell" className="select-text font-mono text-slate-700">{props.historyData[index].EPC}</span></div>;
  return <div className="page-content">
    <PageHeader title="Saved data" subtitle="Retrieve a batch from your reader and export the tag list." actions={<Button onClick={props.isConnected ? props.onFetchHistory : props.onConnect} disabled={busy || (!props.isConnected && !supported)}>{props.isFileTransferring ? 'Downloading…' : props.isConnected ? hasData ? 'Refresh from device' : 'Get saved data' : 'Connect device'}</Button>} />
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 text-sm leading-6 text-slate-500"><span className="mr-2 font-medium text-slate-700">Batch workflow</span>Scan tags → Scan to device → Stop & save batch → Get saved data.</div>
    {shareNotice && <p role="status" className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">{shareNotice}</p>}
    {(saving || props.isFileTransferring || props.transferStatus === 'error') && <section role="status" className="rounded-xl border border-slate-200 bg-white p-5"><p className={`text-sm font-medium ${props.transferStatus === 'error' ? 'text-red-700' : 'text-slate-700'}`}>{saving ? transferCopy.saving : transferCopy[props.transferStatus]}</p>{props.transferStatus !== 'error' && <><div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label={saving ? 'Saving batch' : 'File download'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${progress}%` }} /></div><p className="mt-2 text-right text-xs text-slate-400">{Math.round(progress)}%</p></>}</section>}
    <section className="flex min-h-[360px] flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4"><div><h2 className="text-sm font-semibold">Batch inventory</h2><p className="mt-1 text-xs text-slate-500">{hasData ? `${props.historyData.length.toLocaleString()} unique EPCs` : 'No saved tags loaded'}</p></div>{hasData && <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={props.onDownloadCsv}>Export CSV</Button><Button variant="outline" size="sm" onClick={props.onDownloadTxt}>TXT</Button><Button variant="outline" size="sm" onClick={props.onDownloadJson}>JSON</Button><button className="text-action" onClick={() => void share()}>Share</button><button className="text-action !text-slate-500" onClick={props.onClearFileData}>Clear preview</button></div>}</div>
      {hasData ? <div role="table" aria-label="Saved RFID tags" aria-rowcount={props.historyData.length + 1} className="flex min-h-[280px] flex-1 flex-col overflow-x-auto"><div role="row" className="grid h-11 min-w-[400px] shrink-0 grid-cols-[70px_minmax(240px,1fr)] items-center border-b border-slate-200 bg-slate-50 px-5 text-xs text-slate-500"><span role="columnheader">#</span><span role="columnheader">EPC</span></div><div className="min-h-[240px] flex-1"><AutoSizer>{({ height, width }) => <List height={height} width={Math.max(400, width)} itemCount={props.historyData.length} itemSize={48}>{Row}</List>}</AutoSizer></div></div> : <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center p-8 text-center"><p className="text-base font-semibold text-slate-800">{saving ? 'Your batch is being saved' : props.transferStatus === 'complete' ? 'The saved batch is empty' : 'Bring your batch into view'}</p><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{saving ? 'Wait for the reader to finish, then retrieve the file.' : props.transferStatus === 'complete' ? 'No EPC records were present in the downloaded file. Run another batch scan to collect tags.' : 'Use Scan to device to collect tags on the NHR-10. Stop and save the batch, then select Get saved data above.'}</p></div>}
    </section>
  </div>;
};

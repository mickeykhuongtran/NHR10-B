import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { PageHeader } from './PageHeader';
import { ScannedTagPicker } from './ScannedTagPicker';
import { Tag } from '../../types';

interface OperationsTabProps {
  isConnected: boolean;
  isBusy: boolean;
  tags: Tag[];
  onWriteEpc: (targetEpc: string, newEpc: string, password?: string) => void;
  onWriteData: (epc: string, mem: number, ptr: number, data: string, password?: string) => void;
  writeStatus: 'idle' | 'pending' | 'success' | 'error';
}
const hexWords = (value: string) => /^[0-9A-F]+$/i.test(value) && value.length % 4 === 0;
const validPassword = (value: string) => !value || /^[0-9A-F]{8}$/i.test(value);
const normalize = (value: string) => value.replace(/\s/g, '').toUpperCase();

export const OperationsTab: React.FC<OperationsTabProps> = ({ isConnected, isBusy, tags, onWriteEpc, onWriteData, writeStatus }) => {
  const [quickEpc, setQuickEpc] = useState('');
  const [quickPwd, setQuickPwd] = useState('');
  const [targetEpc, setTargetEpc] = useState('');
  const [bank, setBank] = useState(1);
  const [pointer, setPointer] = useState('2');
  const [data, setData] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState<'quick' | 'advanced' | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const locked = !isConnected || isBusy || writeStatus === 'pending';
  const quickValid = hexWords(quickEpc) && validPassword(quickPwd);
  const advancedValid = hexWords(targetEpc) && hexWords(data) && validPassword(password) && Number.isInteger(Number(pointer)) && Number(pointer) >= 0 && pointer !== '';
  useEffect(() => {
    if (confirmation && !locked) dialogRef.current?.showModal();
    else { dialogRef.current?.close(); if (locked) setConfirmation(null); }
  }, [confirmation, locked]);
  const confirm = () => {
    if (locked) return;
    if (confirmation === 'quick' && quickValid) onWriteEpc('', quickEpc, quickPwd || undefined);
    if (confirmation === 'advanced' && advancedValid) {
      if (bank === 1) onWriteEpc(targetEpc, data, password || undefined);
      else onWriteData(targetEpc, bank, Number(pointer), data, password || undefined);
    }
    setConfirmation(null);
  };
  return <div className="page-content">
    <PageHeader title="Write EPC" subtitle="Assign a new identifier to a tag. Keep only the intended tag in the RF field." />
    {!isConnected && <p className="text-sm text-slate-500">Connect the reader before writing a tag.</p>}
    <section className="grid rounded-xl border border-slate-200 bg-white lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="p-6 sm:p-7">
        <p className="eyebrow">New tag identifier</p>
        <div className="mt-5 space-y-5">
          <Input label="New EPC (hexadecimal)" value={quickEpc} onChange={e => setQuickEpc(normalize(e.target.value))} placeholder="E.g. E20000112233445566778899" className="font-mono" disabled={writeStatus === 'pending'} error={quickEpc && !hexWords(quickEpc) ? 'Enter hexadecimal data in groups of 4 characters.' : undefined} />
          <details><summary className="text-sm text-slate-500">Access password (optional)</summary><div className="mt-3"><Input label="8-character hexadecimal password" value={quickPwd} onChange={e => setQuickPwd(normalize(e.target.value))} placeholder="00000000" maxLength={8} className="font-mono" error={!validPassword(quickPwd) ? 'The password must contain exactly 8 hexadecimal characters.' : undefined} /></div></details>
          <Button disabled={locked || !quickValid} onClick={() => setConfirmation('quick')}>Review & write EPC</Button>
        </div>
      </div>
      <aside className="border-t border-slate-100 bg-slate-50/70 p-6 lg:border-l lg:border-t-0">
        <h2 className="text-sm font-semibold">Before you write</h2>
        <ol className="mt-4 space-y-4 text-sm leading-6 text-slate-500"><li><span className="mr-2 text-slate-400">1.</span>Place one tag close to the reader.</li><li><span className="mr-2 text-slate-400">2.</span>Enter and review the new EPC.</li><li><span className="mr-2 text-slate-400">3.</span>Write, then scan again to verify the identifier.</li></ol>
        <p className="mt-4 text-xs leading-5 text-slate-500">This quick write does not select an existing EPC. With several tags nearby, use Advanced memory write to choose the target.</p>
      </aside>
    </section>
    <details className="rounded-xl border border-slate-200 bg-white">
      <summary className="px-6 py-5 text-sm font-medium">Advanced memory write <span className="ml-2 text-xs font-normal text-slate-400">Select a target EPC and memory bank</span></summary>
      <fieldset disabled={writeStatus === 'pending'} className="min-w-0 space-y-5 border-t border-slate-100 p-6">
        <ScannedTagPicker tags={tags} selectedEpc={targetEpc} onSelect={setTargetEpc} disabled={writeStatus === 'pending'} />
        <p className="text-xs leading-5 text-slate-500">Select a target captured in Scan tags. Manual EPC entry is disabled to prevent targeting an unobserved tag. If two physical tags share the same EPC, isolate the intended tag before writing.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <div><label htmlFor="memory-bank" className="mb-2 block text-sm font-medium text-slate-600">Memory bank</label><select id="memory-bank" className="h-[42px] w-full rounded-lg border border-slate-200 bg-white px-3 text-sm" value={bank} onChange={e => setBank(Number(e.target.value))}><option value={1}>EPC (1)</option><option value={3}>User (3)</option><option value={0}>Reserved (0)</option><option value={2}>TID (2)</option></select></div>
          <Input label="Word pointer" type="number" min={0} value={bank === 1 ? '2' : pointer} onChange={e => setPointer(e.target.value)} disabled={bank === 1} />
          <Input label="Access password (optional)" placeholder="00000000" maxLength={8} value={password} onChange={e => setPassword(normalize(e.target.value))} error={!validPassword(password) ? 'Use 8 hexadecimal characters.' : undefined} />
        </div>
        <Input label={bank === 1 ? 'New EPC (hexadecimal)' : 'Data (hexadecimal words)'} value={data} onChange={e => setData(normalize(e.target.value))} className="font-mono" placeholder="AABBCCDD…" error={data && !hexWords(data) ? 'Use hexadecimal data in groups of 4 characters.' : undefined} />
        <Button variant="outline" disabled={locked || !advancedValid} onClick={() => setConfirmation('advanced')}>Review memory write</Button>
      </fieldset>
    </details>
    <dialog ref={dialogRef} onCancel={() => setConfirmation(null)} onClose={() => setConfirmation(null)} className="w-[calc(100%-32px)] max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl backdrop:bg-slate-900/30" aria-labelledby="confirm-write-title">
      <h2 id="confirm-write-title" className="text-xl font-semibold">Confirm tag write</h2>
      <p className="mt-3 text-sm leading-6 text-slate-500">{confirmation === 'quick' ? 'This write has no target EPC filter. Keep only the intended tag in the RF field; do not rely on the reader to reject multiple tags.' : `This updates memory bank ${bank} using the target EPC below. Keep that tag within range.`}</p>
      <dl className="mt-4 space-y-3 rounded-lg bg-slate-50 p-4 text-sm">{confirmation === 'advanced' && <div><dt className="text-slate-500">Target EPC</dt><dd className="break-all font-mono">{targetEpc}</dd></div>}<div><dt className="text-slate-500">{confirmation === 'quick' || bank === 1 ? 'New EPC' : 'Data'}</dt><dd className="break-all font-mono">{confirmation === 'quick' ? quickEpc : data}</dd></div>{confirmation === 'advanced' && bank !== 1 && <div><dt className="text-slate-500">Word pointer</dt><dd>{pointer}</dd></div>}</dl>
      <div className="mt-6 flex justify-end gap-2"><Button variant="outline" autoFocus onClick={() => setConfirmation(null)}>Cancel</Button><Button variant="primary" onClick={confirm} disabled={locked}>Confirm write</Button></div>
    </dialog>
  </div>;
};

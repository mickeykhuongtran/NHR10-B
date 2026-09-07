import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Tag } from '../../types';

interface ScannedTagPickerProps {
  tags: Tag[];
  selectedEpc: string;
  onSelect: (epc: string) => void;
  disabled?: boolean;
  error?: string;
}

export function ScannedTagPicker({ tags, selectedEpc, onSelect, disabled, error }: ScannedTagPickerProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState({ above: false, height: 224 });
  const options = useMemo(() => tags, [tags]);
  const hasTags = tags.length > 0;
  const expanded = open && hasTags && !disabled;
  const highlighted = Math.min(activeIndex, options.length - 1);

  useEffect(() => { if (!hasTags || disabled) setOpen(false); }, [hasTags, disabled]);
  useEffect(() => {
    if (selectedEpc && !tags.some(tag => tag.epc === selectedEpc)) onSelect('');
  }, [tags, selectedEpc, onSelect]);
  useLayoutEffect(() => {
    if (!expanded) return;
    const trigger = triggerRef.current!;
    const main = trigger.closest('main');
    const place = () => {
      const anchor = trigger.getBoundingClientRect();
      const bounds = main?.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = Math.max(bounds?.top ?? 0, viewport?.offsetTop ?? 0);
      const bottom = Math.min(bounds?.bottom ?? window.innerHeight, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight));
      const below = bottom - anchor.bottom - 8;
      const above = anchor.top - top - 8;
      const useAbove = below < 160 && above > below;
      setPlacement({ above: useAbove, height: Math.max(0, Math.min(224, (useAbove ? above : below) - 33)) });
    };
    place();
    main?.addEventListener('scroll', place);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      main?.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [expanded]);
  useEffect(() => {
    const list = listRef.current;
    const option = list?.children[highlighted] as HTMLElement | undefined;
    if (!list || !option) return;
    // Scroll only the options, keeping the surrounding form in place.
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [expanded, highlighted, options, placement.height]);

  const openList = () => {
    setActiveIndex(Math.max(0, tags.findIndex(tag => tag.epc === selectedEpc)));
    setOpen(true);
  };
  const select = (epc: string) => {
    onSelect(epc);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!hasTags) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!expanded) openList();
      else setActiveIndex(Math.max(0, Math.min(options.length - 1, highlighted + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter' && expanded) {
      event.preventDefault();
      if (options[highlighted]) select(options[highlighted].epc);
    } else if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return <div className="w-full" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <label id={`${id}-label`} htmlFor={id} className="mb-2 block text-sm font-medium text-slate-600">Target EPC</label>
    <div className="relative">
      <button ref={triggerRef} id={id} type="button" disabled={disabled || !hasTags}
        role="combobox" aria-labelledby={`${id}-label`} aria-readonly="true" aria-haspopup="listbox"
        aria-expanded={expanded} aria-controls={expanded ? `${id}-options` : undefined}
        aria-activedescendant={expanded && highlighted >= 0 ? `${id}-option-${highlighted}` : undefined}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
        className={`controller-input flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border bg-white px-3 py-2 text-left font-mono text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:bg-slate-50 ${error ? 'border-red-500 text-red-700' : 'border-slate-200 text-slate-900 focus:border-blue-500'}`}
        onKeyDown={onKeyDown} onClick={() => { if (expanded) setOpen(false); else openList(); }}>
        <span className={selectedEpc ? 'break-all' : 'font-sans text-slate-400'}>{selectedEpc || (hasTags ? 'Select a scanned EPC' : 'No scanned EPC available')}</span>
        <ChevronDown size={18} aria-hidden="true" className={`shrink-0 text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && <div className={`absolute inset-x-0 z-20 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg ${placement.above ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
        <div className="flex justify-between gap-2 border-b border-slate-100 px-3 py-2 text-xs text-slate-500"><span>Scanned EPCs</span><span>{tags.length} tags</span></div>
        <ul ref={listRef} id={`${id}-options`} role="listbox" aria-label="Scanned write targets" style={{ maxHeight: placement.height }} className="relative overflow-y-auto overscroll-contain py-1">
          {options.map((tag, index) => <li key={tag.epc} id={`${id}-option-${index}`} role="option" aria-selected={selectedEpc === tag.epc}
            className={`cursor-pointer break-all px-3 py-2.5 font-mono text-xs ${index === highlighted ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50'}`}
            onMouseDown={event => event.preventDefault()} onClick={() => select(tag.epc)}>{tag.epc}</li>)}
        </ul>
      </div>}
    </div>
    {error && <p id={`${id}-error`} className="mt-1 text-sm text-red-700">{error}</p>}
  </div>;
}

import React from 'react';

interface PageHeaderProps {
  icon?: React.ElementType;
  title: string;
  subtitle?: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  actions,
  className = '',
  meta,
  subtitle,
  title,
}) => (
  <header className={`page-header flex min-w-0 shrink-0 flex-col gap-4 md:flex-row md:items-center md:justify-between ${className}`}>
    <div className="flex min-w-0 items-start gap-3 text-left">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h1 className="text-2xl font-semibold leading-tight tracking-tight text-slate-900 sm:text-[28px]">
            {title}
          </h1>
          {meta && (
            <div className="flex min-w-0 items-center">
              {meta}
            </div>
          )}
        </div>
        {subtitle && (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
            {subtitle}
          </p>
        )}
      </div>
    </div>

    {actions && (
      <div className="flex w-full flex-wrap items-center gap-2 md:w-auto md:justify-end">
        {actions}
      </div>
    )}
  </header>
);

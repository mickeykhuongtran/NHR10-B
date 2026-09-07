import React, { useId } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input: React.FC<InputProps> = ({ label, error, className = '', ...props }) => {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <div className="w-full">
      {label && <label htmlFor={id} className="mb-2 block text-sm font-medium text-slate-600">{label}</label>}
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`controller-input w-full bg-white border ${error ? 'border-red-500 text-red-700' : 'border-slate-200 focus:border-blue-500 text-slate-900'} rounded-lg px-3 py-2 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/10 transition-colors ${className}`}
        {...props}
      />
      {error && <p id={`${id}-error`} className="mt-1 text-sm text-red-700">{error}</p>}
    </div>
  );
};

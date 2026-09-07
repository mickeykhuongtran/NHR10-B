import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
}

export const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'primary', 
  size = 'md', 
  fullWidth = false,
  className = '',
  ...props 
}) => {
  const baseStyles = 'controller-button inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:opacity-45 disabled:cursor-not-allowed border';
  
  const variants = {
    primary: 'button-primary bg-blue-600 text-white border-blue-600 hover:bg-blue-700',
    secondary: 'button-secondary bg-white text-slate-700 border-slate-200 hover:bg-slate-50',
    danger: 'button-danger bg-red-600 text-white border-red-600 hover:bg-red-700',
    success: 'button-success bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700',
    outline: 'button-secondary bg-white text-slate-700 border-slate-200 hover:bg-slate-50',
    ghost: 'button-ghost text-slate-600 hover:text-slate-900 hover:bg-slate-100 border-transparent'
  };

  const sizes = {
    sm: 'px-3 py-2 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-5 py-2.5 text-base'
  };

  return (
    <button 
      type="button"
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${fullWidth ? 'w-full' : ''} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

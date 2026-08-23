// components/ui/Input.tsx
import { forwardRef } from "react";

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  error?: string;
  helperText?: string;
  variant?: 'default' | 'filled' | 'outlined';
  size?: 'sm' | 'md' | 'lg';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ 
    label, 
    error, 
    helperText, 
    variant = 'default', 
    size = 'md', 
    className = '',
    type = 'text',
    ...props 
  }, ref) => {
    const sizeClasses = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-3 py-2 text-sm',
      lg: 'px-4 py-3 text-base'
    };

    const variantClasses = {
      default: 'border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500',
      filled: 'bg-gray-50 border border-transparent focus:bg-white focus:ring-2 focus:ring-indigo-500',
      outlined: 'border-2 border-gray-300 focus:ring-0 focus:border-indigo-500'
    };

    const baseClasses = `
      block w-full rounded-md shadow-sm transition-colors
      disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500
      ${sizeClasses[size]}
      ${variantClasses[variant]}
      ${error ? 'border-red-300 focus:border-red-500 focus:ring-red-500' : ''}
      ${className}
    `.trim().replace(/\s+/g, ' ');

    return (
      <div className="space-y-1">
        {label && (
          <label className="block text-sm font-medium text-gray-700">
            {label}
          </label>
        )}
        <input
          ref={ref}
          type={type}
          className={baseClasses}
          {...props}
        />
        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}
        {helperText && !error && (
          <p className="text-sm text-gray-500">{helperText}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

// Textarea component
interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
  variant?: 'default' | 'filled' | 'outlined';
  size?: 'sm' | 'md' | 'lg';
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ 
    label, 
    error, 
    helperText, 
    variant = 'default', 
    size = 'md', 
    className = '',
    rows = 3,
    ...props 
  }, ref) => {
    const sizeClasses = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-3 py-2 text-sm', 
      lg: 'px-4 py-3 text-base'
    };

    const variantClasses = {
      default: 'border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500',
      filled: 'bg-gray-50 border border-transparent focus:bg-white focus:ring-2 focus:ring-indigo-500',
      outlined: 'border-2 border-gray-300 focus:ring-0 focus:border-indigo-500'
    };

    const baseClasses = `
      block w-full rounded-md shadow-sm transition-colors resize-vertical
      disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500
      ${sizeClasses[size]}
      ${variantClasses[variant]}
      ${error ? 'border-red-300 focus:border-red-500 focus:ring-red-500' : ''}
      ${className}
    `.trim().replace(/\s+/g, ' ');

    return (
      <div className="space-y-1">
        {label && (
          <label className="block text-sm font-medium text-gray-700">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          rows={rows}
          className={baseClasses}
          {...props}
        />
        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}
        {helperText && !error && (
          <p className="text-sm text-gray-500">{helperText}</p>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

// Select component
interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  error?: string;
  helperText?: string;
  variant?: 'default' | 'filled' | 'outlined';
  size?: 'sm' | 'md' | 'lg';
  placeholder?: string;
  options?: Array<{ value: string; label: string; disabled?: boolean }>;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ 
    label, 
    error, 
    helperText, 
    variant = 'default', 
    size = 'md', 
    className = '',
    placeholder,
    options = [],
    children,
    ...props 
  }, ref) => {
    const sizeClasses = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-3 py-2 text-sm',
      lg: 'px-4 py-3 text-base'
    };

    const variantClasses = {
      default: 'border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500',
      filled: 'bg-gray-50 border border-transparent focus:bg-white focus:ring-2 focus:ring-indigo-500',
      outlined: 'border-2 border-gray-300 focus:ring-0 focus:border-indigo-500'
    };

    const baseClasses = `
      block w-full rounded-md shadow-sm transition-colors
      disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500
      ${sizeClasses[size]}
      ${variantClasses[variant]}
      ${error ? 'border-red-300 focus:border-red-500 focus:ring-red-500' : ''}
      ${className}
    `.trim().replace(/\s+/g, ' ');

    return (
      <div className="space-y-1">
        {label && (
          <label className="block text-sm font-medium text-gray-700">
            {label}
          </label>
        )}
        <select
          ref={ref}
          className={baseClasses}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((option) => (
            <option 
              key={option.value} 
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </option>
          ))}
          {children}
        </select>
        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}
        {helperText && !error && (
          <p className="text-sm text-gray-500">{helperText}</p>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';
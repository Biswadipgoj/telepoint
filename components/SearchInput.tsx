'use client';

import { useRef, useEffect, useState } from 'react';

interface SearchInputProps {
  value?: string;
  onChange?: (v: string) => void;
  onSearch?: (v: string) => void;   // uncontrolled / legacy alias
  placeholder?: string;
  loading?: boolean;
  autoFocus?: boolean;
}

export default function SearchInput({
  value: externalValue,
  onChange,
  onSearch,
  placeholder = 'Search name / IMEI / Aadhaar…',
  loading,
  autoFocus,
}: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Uncontrolled mode: parent only gives onSearch callback, no value prop
  const isControlled = externalValue !== undefined && onChange !== undefined;
  const [internalValue, setInternalValue] = useState('');

  const displayValue = isControlled ? externalValue! : internalValue;

  function handleChange(v: string) {
    if (isControlled) {
      onChange!(v);
    } else {
      setInternalValue(v);
      onSearch?.(v);
    }
  }

  function handleClear() {
    if (isControlled) {
      onChange!('');
    } else {
      setInternalValue('');
      onSearch?.('');
    }
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (autoFocus) {
      // Slight delay so modal transitions don't steal focus
      const t = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [autoFocus]);

  return (
    <div className="relative">
      {/* Search / spinner icon */}
      <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none">
        {loading ? (
          <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 010 20" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
        )}
      </div>

      {/* Never use type="search" — it adds browser-native clear buttons that conflict */}
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        onChange={e => handleChange(e.target.value)}
        placeholder={placeholder}
        className="input pl-10 pr-10 py-3 text-base shadow-sm"
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
      />

      {/* Clear button */}
      {displayValue && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-full text-ink-muted hover:bg-surface-3 hover:text-ink transition-colors"
          aria-label="Clear search"
        >
          <svg width="12" height="12" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

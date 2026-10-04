import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { useEffect, useId, useState, type InputHTMLAttributes } from 'react'

type SecretInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value'
> & {
  label: string
  value: string
}

/** A controlled secret field with local, opt-in visibility; clearing resets masking. */
export default function SecretInput({
  label,
  value,
  id,
  className = '',
  disabled,
  ...props
}: SecretInputProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!value || disabled) setVisible(false)
  }, [value, disabled])
  const action = `${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`
  return (
    <div id={`${inputId}-field`}>
      <label htmlFor={inputId} className="block text-sm">
        {label}
      </label>
      <div id={`${inputId}-control`} className="relative mt-1">
        <input
          {...props}
          id={inputId}
          value={value}
          disabled={disabled}
          type={visible ? 'text' : 'password'}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className={`w-full rounded-nb-sm border border-nb-border bg-nb-surface py-2 pl-2 pr-10 text-sm text-nb-text ${className}`}
        />
        <button
          type="button"
          aria-label={action}
          title={action}
          aria-pressed={visible}
          aria-controls={inputId}
          disabled={disabled}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-nb-sm text-nb-text-muted hover:text-nb-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40"
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? (
            <EyeSlashIcon className="h-5 w-5" />
          ) : (
            <EyeIcon className="h-5 w-5" />
          )}
        </button>
      </div>
    </div>
  )
}

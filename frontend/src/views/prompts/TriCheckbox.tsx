// Tri-state checkbox for the prompts batch-selection hierarchy (条/session/组).
// The shared ui/checkbox renders a check for the indeterminate state; this one
// shows a minus, matching the legacy native-checkbox 半选 affordance.

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';

import { cn } from '@/lib/utils';

interface TriCheckboxProps {
  checked: boolean | 'indeterminate';
  onCheckedChange: (checked: boolean) => void;
  title?: string;
  className?: string;
}

export function TriCheckbox({ checked, onCheckedChange, title, className }: TriCheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      // Radix reports the *next* state; indeterminate never comes back from a click.
      onCheckedChange={(value) => onCheckedChange(value === true)}
      onClick={(e) => e.stopPropagation()}
      title={title}
      className={cn(
        'grid h-4 w-4 shrink-0 place-content-center rounded-sm border border-primary shadow',
        'data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        'data-[state=indeterminate]:bg-primary/40 data-[state=indeterminate]:text-primary-foreground',
        className
      )}
    >
      <CheckboxPrimitive.Indicator className="grid place-content-center text-current">
        {checked === 'indeterminate' ? <Minus className="h-3 w-3" /> : <Check className="h-3 w-3" />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

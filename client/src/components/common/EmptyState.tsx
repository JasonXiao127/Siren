import { Music } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  title: string;
  description?: string;
  className?: string;
}

export function EmptyState({ title, description, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 py-16 text-center',
        className
      )}
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
        <Music className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-semibold">{title}</h3>
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
import { useState, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Heart } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { setFavorite } from '@/api/jellyfin';
import { cn } from '@/lib/utils';

interface LikeButtonProps {
  itemId: string;
  isFavorite: boolean;
  className?: string;
}

export default function LikeButton({ itemId, isFavorite, className }: LikeButtonProps) {
  const userId = useAuthStore((state) => state.userId);
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);

  async function handleToggle(e: MouseEvent) {
    e.stopPropagation();
    if (!userId || isPending) return;

    setIsPending(true);
    try {
      await setFavorite(userId, itemId, !isFavorite);
      // Invalidate favorites and any track lists that may show favorite state
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['favorites'] }),
        queryClient.invalidateQueries({ queryKey: ['playlists'] }),
        queryClient.invalidateQueries({ queryKey: ['recently-added'] }),
        queryClient.invalidateQueries({ queryKey: ['recently-played'] }),
        queryClient.invalidateQueries({ queryKey: ['frequently-played'] }),
        queryClient.invalidateQueries({ queryKey: ['search'] }),
        queryClient.invalidateQueries({ queryKey: ['playlist-tracks'] }),
        queryClient.invalidateQueries({ queryKey: ['album-tracks'] }),
      ]);
    } catch {
      toast.error('Could not update favorite');
    } finally {
      setIsPending(false);
    }
  }

  return (
    <button
      onClick={handleToggle}
      disabled={isPending}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
        isFavorite
          ? 'text-primary'
          : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100',
        className
      )}
      title={isFavorite ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
    >
      <Heart
        className={cn('h-4 w-4', isFavorite && 'fill-current')}
      />
    </button>
  );
}
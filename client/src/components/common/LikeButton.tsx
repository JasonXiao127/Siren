import { useState, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
      await queryClient.invalidateQueries({ queryKey: ['favorites'] });
      await queryClient.invalidateQueries({ queryKey: ['playlists'] });
      await queryClient.invalidateQueries({ queryKey: ['recently-added'] });
      await queryClient.invalidateQueries({ queryKey: ['recently-played'] });
      await queryClient.invalidateQueries({ queryKey: ['frequently-played'] });
      await queryClient.invalidateQueries({ queryKey: ['search'] });
      await queryClient.invalidateQueries({ queryKey: ['playlist-tracks'] });
      await queryClient.invalidateQueries({ queryKey: ['album-tracks'] });
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
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/store/playerStore';
import { getFavorites, buildTrackImageUrl } from '@/api/jellyfin';
import { Artwork } from '@/components/common/Artwork';
import { LoadingSkeleton } from '@/components/common/LoadingSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { Play, Clock, Heart } from 'lucide-react';
import { cn } from '@/lib/utils';
import LikeButton from '@/components/common/LikeButton';

export default function Favorites() {
  const userId = useAuthStore((state) => state.userId);
  const playQueue = usePlayerStore((state) => state.playQueue);
  const playSingle = usePlayerStore((state) => state.playSingle);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const queue = usePlayerStore((state) => state.queue);

  const { data: tracks, isLoading } = useQuery({
    queryKey: ['favorites', userId],
    queryFn: () => getFavorites(userId),
    enabled: !!userId,
  });

  function handlePlayAll() {
    if (tracks && tracks.length > 0) {
      playQueue(tracks, 0);
    }
  }

  function handlePlayTrack(index: number) {
    if (tracks) {
      playSingle(tracks[index]);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end gap-6">
        <div className="flex h-48 w-48 items-center justify-center rounded-md bg-gradient-to-br from-primary/40 to-primary/10 shadow-lg">
          <Heart className="h-16 w-16 text-primary" />
        </div>
        <div className="flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Playlist
          </p>
          <h1 className="text-4xl font-bold">Liked Songs</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {tracks?.length || 0} songs
          </p>
          {tracks && tracks.length > 0 && (
            <div className="mt-4">
              <button
                onClick={handlePlayAll}
                className="flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Play className="h-4 w-4 fill-current" />
                Play
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Track list */}
      {isLoading ? (
        <LoadingSkeleton variant="list" count={10} />
      ) : !tracks || tracks.length === 0 ? (
        <EmptyState
          title="No liked songs yet"
          description="Tap the heart on any song to add it here"
        />
      ) : (
        <div className="space-y-1">
          {/* Header row */}
          <div className="flex items-center gap-4 border-b border-border px-4 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <span className="w-8 text-center">#</span>
            <span className="flex-1">Title</span>
            <span className="w-40">Album</span>
            <span className="w-16 text-right">
              <Clock className="ml-auto h-3.5 w-3.5" />
            </span>
            <span className="w-8" />
          </div>

          {tracks.map((track, index) => {
            const isCurrent = queue[currentIndex]?.Id === track.Id;
            const imageUrl = buildTrackImageUrl(track, 100);

            return (
              <div
                key={track.Id}
                className={cn(
                  'group flex cursor-pointer items-center gap-4 rounded-md px-4 py-2 transition-colors',
                  isCurrent ? 'bg-secondary' : 'hover:bg-secondary/50'
                )}
                onClick={() => handlePlayTrack(index)}
              >
                <span className={cn('w-8 text-center text-sm tabular-nums', isCurrent ? 'text-primary' : 'text-muted-foreground')}>
                  {isCurrent ? (
                    <Play className="mx-auto h-4 w-4 fill-current" />
                  ) : (
                    index + 1
                  )}
                </span>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Artwork
                    src={imageUrl}
                    alt={track.Name}
                    className="h-10 w-10 rounded"
                    iconClassName="h-4 w-4"
                    objectFit="contain"
                  />
                  <div className="min-w-0">
                    <p className={cn('truncate text-sm', isCurrent ? 'text-primary' : 'text-foreground')}>
                      {track.Name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {track.Artists?.[0] || track.AlbumArtist || 'Unknown Artist'}
                    </p>
                  </div>
                </div>
                <span className="w-40 truncate text-sm text-muted-foreground">
                  {track.Album || '—'}
                </span>
                <span className="w-16 text-right text-sm tabular-nums text-muted-foreground">
                  {track.RunTimeTicks ? formatTicks(track.RunTimeTicks) : '—'}
                </span>
                <span className="w-8">
                  <LikeButton itemId={track.Id} isFavorite={true} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatTicks(ticks: number): string {
  const seconds = Math.floor(ticks / 10_000_000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
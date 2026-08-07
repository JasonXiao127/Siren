import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/store/playerStore';
import { getAlbumTracks, getItem, buildImageUrl, buildTrackImageUrl } from '@/api/jellyfin';
import { Artwork } from '@/components/common/Artwork';
import { LoadingSkeleton } from '@/components/common/LoadingSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import LikeButton from '@/components/common/LikeButton';
import { Play, Shuffle, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function AlbumView() {
  const { id } = useParams<{ id: string }>();
  const userId = useAuthStore((state) => state.userId);
  const playQueue = usePlayerStore((state) => state.playQueue);
  const playShuffled = usePlayerStore((state) => state.playShuffled);
  const playSingle = usePlayerStore((state) => state.playSingle);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const queue = usePlayerStore((state) => state.queue);

  const { data: album } = useQuery({
    queryKey: ['album', userId, id],
    queryFn: () => getItem(userId, id!),
    enabled: !!userId && !!id,
  });

  const { data: tracks, isLoading } = useQuery({
    queryKey: ['album-tracks', userId, id],
    queryFn: () => getAlbumTracks(userId, id!),
    enabled: !!userId && !!id,
  });

  function handlePlayAll() {
    if (tracks && tracks.length > 0) {
      playQueue(tracks, 0);
    }
  }

  function handleShuffleAll() {
    if (tracks && tracks.length > 0) {
      playShuffled(tracks);
    }
  }

  function handlePlayTrack(index: number) {
    if (tracks) {
      playSingle(tracks[index]);
    }
  }

  const albumImageUrl = id ? buildImageUrl(id, 300) : null;
  const albumArtist = tracks?.[0]?.AlbumArtist || tracks?.[0]?.Artists?.[0];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end gap-6">
        <Artwork
          src={albumImageUrl}
          alt="Album"
          className="h-48 w-48 rounded-md shadow-lg"
          iconClassName="h-16 w-16"
        />
        <div className="flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Album
          </p>
          <h1 className="text-4xl font-bold">{album?.Name || 'Album'}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {albumArtist || 'Unknown Artist'} · {tracks?.length || 0} songs
          </p>
          {tracks && tracks.length > 0 && (
            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={handlePlayAll}
                className="flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Play className="h-4 w-4 fill-current" />
                Play
              </button>
              <button
                onClick={handleShuffleAll}
                className="flex items-center gap-2 rounded-full bg-secondary px-6 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary/70"
                title="Shuffle play"
              >
                <Shuffle className="h-4 w-4" />
                Shuffle
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
          title="No tracks found"
          description="This album has no tracks"
        />
      ) : (
        <div className="space-y-1">
          {/* Header row */}
          <div className="flex items-center gap-4 border-b border-border px-4 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <span className="w-8 text-center">#</span>
            <span className="flex-1">Title</span>
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
                <span className="w-16 text-right text-sm tabular-nums text-muted-foreground">
                  {track.RunTimeTicks ? formatTicks(track.RunTimeTicks) : '—'}
                </span>
                <span className="w-8">
                  <LikeButton
                    itemId={track.Id}
                    isFavorite={!!track.UserData?.IsFavorite}
                  />
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
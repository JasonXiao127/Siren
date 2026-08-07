import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/store/playerStore';
import {
  getRecentlyAdded,
  getRecentlyPlayed,
  getFrequentlyPlayed,
  buildTrackImageUrl,
} from '@/api/jellyfin';
import { Artwork } from '@/components/common/Artwork';
import { LoadingSkeleton } from '@/components/common/LoadingSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import AddToPlaylistDialog from '@/components/player/AddToPlaylistDialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Play, MoreHorizontal, ListPlus } from 'lucide-react';
import type { Track } from '@/store/playerStore';

export default function Home() {
  const userId = useAuthStore((state) => state.userId);
  const playQueue = usePlayerStore((state) => state.playQueue);
  const playSingle = usePlayerStore((state) => state.playSingle);
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState<Track | null>(null);

  const { data: recentlyAdded, isLoading: recentlyAddedLoading } = useQuery({
    queryKey: ['recently-added', userId],
    queryFn: () => getRecentlyAdded(userId),
    enabled: !!userId,
  });

  const { data: recentlyPlayed, isLoading: recentlyLoading } = useQuery({
    queryKey: ['recently-played', userId],
    queryFn: () => getRecentlyPlayed(userId),
    enabled: !!userId,
  });

  const { data: frequentlyPlayed, isLoading: frequentlyLoading } = useQuery({
    queryKey: ['frequently-played', userId],
    queryFn: () => getFrequentlyPlayed(userId),
    enabled: !!userId,
  });

  function handlePlayAll(tracks: Track[]) {
    if (tracks && tracks.length > 0) {
      playQueue(tracks, 0);
    }
  }

  function handlePlayTrack(track: Track) {
    playSingle(track);
  }

  return (
    <div className="space-y-8">
      {/* Recently Played */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Recently Played</h1>
          {recentlyPlayed && recentlyPlayed.length > 0 && (
            <button
              onClick={() => handlePlayAll(recentlyPlayed)}
              className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Play className="h-4 w-4 fill-current" />
              Play All
            </button>
          )}
        </div>

        {recentlyLoading ? (
          <LoadingSkeleton />
        ) : !recentlyPlayed || recentlyPlayed.length === 0 ? (
          <EmptyState
            title="Nothing played yet"
            description="Songs you play will show up here"
          />
        ) : (
          <TrackGrid
            tracks={recentlyPlayed}
            onPlayTrack={handlePlayTrack}
            onOpenMenu={(track) => setAddToPlaylistTrack(track)}
          />
        )}
      </section>

      {/* Frequently Played */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Frequently Played</h1>
          {frequentlyPlayed && frequentlyPlayed.length > 0 && (
            <button
              onClick={() => handlePlayAll(frequentlyPlayed)}
              className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Play className="h-4 w-4 fill-current" />
              Play All
            </button>
          )}
        </div>

        {frequentlyLoading ? (
          <LoadingSkeleton />
        ) : !frequentlyPlayed || frequentlyPlayed.length === 0 ? (
          <EmptyState
            title="No frequently played songs"
            description="Songs you play often will show up here"
          />
        ) : (
          <TrackGrid
            tracks={frequentlyPlayed}
            onPlayTrack={handlePlayTrack}
            onOpenMenu={(track) => setAddToPlaylistTrack(track)}
          />
        )}
      </section>

      {/* Recently Added */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Recently Added</h1>
          {recentlyAdded && recentlyAdded.length > 0 && (
            <button
              onClick={() => handlePlayAll(recentlyAdded)}
              className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Play className="h-4 w-4 fill-current" />
              Play All
            </button>
          )}
        </div>

        {recentlyAddedLoading ? (
          <LoadingSkeleton />
        ) : !recentlyAdded || recentlyAdded.length === 0 ? (
          <EmptyState
            title="No music found"
            description="Add music to your Jellyfin library to see it here"
          />
        ) : (
          <TrackGrid
            tracks={recentlyAdded}
            onPlayTrack={handlePlayTrack}
            onOpenMenu={(track) => setAddToPlaylistTrack(track)}
          />
        )}
      </section>

      {/* Add-to-playlist dialog for a clicked song card */}
      <AddToPlaylistDialog
        open={!!addToPlaylistTrack}
        onOpenChange={(open) => {
          if (!open) setAddToPlaylistTrack(null);
        }}
        trackIds={addToPlaylistTrack ? [addToPlaylistTrack.Id] : []}
      />
    </div>
  );
}

function TrackGrid({
  tracks,
  onPlayTrack,
  onOpenMenu,
}: {
  tracks: Track[];
  onPlayTrack: (track: Track) => void;
  onOpenMenu: (track: Track) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {tracks.map((track) => {
        const imageUrl = buildTrackImageUrl(track, 300);
        return (
          <div
            key={track.Id}
            className="group cursor-pointer space-y-2 rounded-md p-3 transition-colors hover:bg-secondary/50"
            onClick={() => onPlayTrack(track)}
          >
            <div className="relative">
              <Artwork
                src={imageUrl}
                alt={track.Name}
                className="aspect-square w-full rounded-md"
                iconClassName="h-10 w-10"
                objectFit="contain"
              />
              <div className="absolute bottom-2 right-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                <Play className="h-5 w-5 fill-current" />
              </div>
            </div>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{track.Name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {track.Artists?.[0] || track.AlbumArtist || 'Unknown Artist'}
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    onClick={(e) => e.stopPropagation()}
                    title="More options"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenMenu(track);
                    }}
                  >
                    <ListPlus className="h-4 w-4" />
                    Add to playlist…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        );
      })}
    </div>
  );
}
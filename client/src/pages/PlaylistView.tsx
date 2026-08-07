import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/store/playerStore';
import {
  getPlaylistTracks,
  getItem,
  buildImageUrl,
  buildTrackImageUrl,
  deletePlaylist,
  removeTracksFromPlaylist,
} from '@/api/jellyfin';
import { Artwork } from '@/components/common/Artwork';
import { LoadingSkeleton } from '@/components/common/LoadingSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import LikeButton from '@/components/common/LikeButton';
import AddToPlaylistDialog from '@/components/player/AddToPlaylistDialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { Play, Shuffle, Clock, Trash2, MoreHorizontal, ListPlus } from 'lucide-react';
import { cn } from '@/lib/utils';

const CONFIRM_RESET_MS = 3000;

export default function PlaylistView() {
  const { id } = useParams<{ id: string }>();
  const userId = useAuthStore((state) => state.userId);
  const playQueue = usePlayerStore((state) => state.playQueue);
  const playShuffled = usePlayerStore((state) => state.playShuffled);
  const playSingle = usePlayerStore((state) => state.playSingle);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const queue = usePlayerStore((state) => state.queue);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteStep, setDeleteStep] = useState(0);
  const [addToPlaylistOpen, setAddToPlaylistOpen] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-reset the delete confirmation if the user doesn't confirm in time
  useEffect(() => {
    if (deleteStep === 0) return;
    confirmTimerRef.current = setTimeout(() => setDeleteStep(0), CONFIRM_RESET_MS);
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, [deleteStep]);

  const { data: playlist } = useQuery({
    queryKey: ['playlist', userId, id],
    queryFn: () => getItem(userId, id!),
    enabled: !!userId && !!id,
  });

  const { data: tracks, isLoading } = useQuery({
    queryKey: ['playlist-tracks', userId, id],
    queryFn: () => getPlaylistTracks(userId, id!),
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

  async function handleRemoveTrack(trackId: string, entryId?: string) {
    if (!userId || !id) return;
    try {
      const entryIds = entryId ? [entryId] : [trackId];
      await removeTracksFromPlaylist(userId, id, entryIds);
      await queryClient.invalidateQueries({ queryKey: ['playlist-tracks', userId, id] });
      toast.success('Removed from playlist');
    } catch (error) {
      console.error('Failed to remove track from playlist', error);
      toast.error('Could not remove song from playlist');
    }
  }

  async function handleDeletePlaylist() {
    if (!id || !userId || deleteStep < 2) return;

    try {
      await deletePlaylist(userId, id);
      await queryClient.invalidateQueries({ queryKey: ['playlists'] });
      toast.success('Playlist deleted');
      navigate('/');
    } catch (error) {
      console.error('Failed to delete playlist', error);
      const err = error as {
        response?: { status?: number; data?: unknown };
        message?: string;
      };
      const data = err.response?.data as
        | { error?: string; Exception?: { Message?: string } }
        | string
        | undefined;
      const detail =
        (typeof data === 'string' && data) ||
        (data && typeof data === 'object' && (data.error || data.Exception?.Message)) ||
        err.message ||
        'Could not delete playlist';
      const status = err.response?.status ? ` (${err.response.status})` : '';
      toast.error(`${detail}${status}`);
    }
  }

  const playlistImageUrl = id ? buildImageUrl(id, 300) : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end gap-6">
        <Artwork
          src={playlistImageUrl}
          alt="Playlist"
          className="h-48 w-48 rounded-md shadow-lg"
          iconClassName="h-16 w-16"
        />
        <div className="flex-1">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Playlist
              </p>
              <h1 className="text-4xl font-bold">{playlist?.Name || 'Playlist'}</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {tracks?.length || 0} songs
              </p>
            </div>
            <div className="flex shrink-0 items-start gap-2">
              <button
                onClick={() => {
                  if (deleteStep >= 2) {
                    void handleDeletePlaylist();
                  } else {
                    setDeleteStep((s) => (s + 1) as 0 | 1 | 2);
                  }
                }}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  deleteStep === 0 &&
                    'bg-secondary text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
                  deleteStep === 1 && 'bg-destructive/20 text-destructive hover:bg-destructive/30',
                  deleteStep === 2 &&
                    'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                )}
                title={
                  deleteStep === 0
                    ? 'Delete playlist'
                    : deleteStep === 1
                      ? 'Are you sure? Click again to confirm'
                      : 'Click again to confirm deletion'
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleteStep === 0 ? 'Delete' : deleteStep === 1 ? 'Are you sure?' : 'Confirm delete?'}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    title="More options"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={!tracks || tracks.length === 0}
                    onClick={() => setAddToPlaylistOpen(true)}
                  >
                    <ListPlus className="h-4 w-4" />
                    Add all songs to playlist…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
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
          title="This playlist is empty"
          description="Add songs to this playlist in Jellyfin"
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
            <span className="w-16" />
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
                <span className="flex w-16 items-center justify-end gap-1">
                  <LikeButton
                    itemId={track.Id}
                    isFavorite={!!track.UserData?.IsFavorite}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                        title="More options"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel className="max-w-48 truncate">{track.Name}</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRemoveTrack(track.Id, track.PlaylistItemId);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        Remove from playlist
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Add-all-to-playlist dialog */}
      <AddToPlaylistDialog
        open={addToPlaylistOpen}
        onOpenChange={setAddToPlaylistOpen}
        trackIds={tracks?.map((t) => t.Id) || []}
        excludePlaylistId={id}
      />
    </div>
  );
}

function formatTicks(ticks: number): string {
  const seconds = Math.floor(ticks / 10_000_000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
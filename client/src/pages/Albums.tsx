import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/store/playerStore';
import { getAlbums, getAlbumTracks, buildImageUrl } from '@/api/jellyfin';
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

export default function Albums() {
  const navigate = useNavigate();
  const userId = useAuthStore((state) => state.userId);
  const playQueue = usePlayerStore((state) => state.playQueue);
  const [addToPlaylistTrackIds, setAddToPlaylistTrackIds] = useState<string[] | null>(null);
  const [loadingAlbumId, setLoadingAlbumId] = useState<string | null>(null);

  const { data: albums, isLoading } = useQuery({
    queryKey: ['albums', userId],
    queryFn: () => getAlbums(userId),
    enabled: !!userId,
  });

  async function handlePlayAlbum(albumId: string) {
    const tracks = await getAlbumTracks(userId, albumId);
    if (tracks.length > 0) {
      playQueue(tracks, 0);
    }
  }

  async function handleAddAlbumToPlaylist(albumId: string) {
    if (!userId || loadingAlbumId) return;
    setLoadingAlbumId(albumId);
    try {
      const tracks = await getAlbumTracks(userId, albumId);
      setAddToPlaylistTrackIds(tracks.map((t) => t.Id));
    } catch (error) {
      console.error('Failed to load album tracks', error);
    } finally {
      setLoadingAlbumId(null);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Albums</h1>

      {isLoading ? (
        <LoadingSkeleton />
      ) : !albums || albums.length === 0 ? (
        <EmptyState
          title="No albums found"
          description="Add music to your Jellyfin library to see albums here"
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {albums.map((album) => {
            const imageUrl = buildImageUrl(album.Id, 300);
            return (
              <div
                key={album.Id}
                className="group space-y-2 rounded-md p-3 transition-colors hover:bg-secondary/50"
              >
                <div
                  className="relative cursor-pointer"
                  onClick={() => navigate(`/album/${album.Id}`)}
                >
                  <Artwork
                    src={imageUrl}
                    alt={album.Name}
                    className="aspect-square w-full rounded-md"
                    iconClassName="h-10 w-10"
                  />
                  <div
                    className="absolute bottom-2 right-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handlePlayAlbum(album.Id);
                    }}
                  >
                    <Play className="h-5 w-5 fill-current" />
                  </div>
                </div>
                <div className="flex items-start justify-between gap-2">
                  <div
                    className="min-w-0 cursor-pointer"
                    onClick={() => navigate(`/album/${album.Id}`)}
                  >
                    <p className="truncate text-sm font-medium">{album.Name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {album.AlbumArtist || album.Artists?.[0] || 'Album'}
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
                        disabled={loadingAlbumId === album.Id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleAddAlbumToPlaylist(album.Id);
                        }}
                      >
                        <ListPlus className="h-4 w-4" />
                        {loadingAlbumId === album.Id ? 'Loading…' : 'Add album to playlist…'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add-album-to-playlist dialog */}
      <AddToPlaylistDialog
        open={!!addToPlaylistTrackIds}
        onOpenChange={(open) => {
          if (!open) setAddToPlaylistTrackIds(null);
        }}
        trackIds={addToPlaylistTrackIds || []}
      />
    </div>
  );
}
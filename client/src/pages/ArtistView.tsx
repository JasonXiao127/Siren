import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/store/playerStore';
import { getArtistAlbums, getItem, buildImageUrl, getAlbumTracks } from '@/api/jellyfin';
import { Artwork } from '@/components/common/Artwork';
import { LoadingSkeleton } from '@/components/common/LoadingSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { Play } from 'lucide-react';

export default function ArtistView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const userId = useAuthStore((state) => state.userId);
  const playQueue = usePlayerStore((state) => state.playQueue);

  const { data: artist } = useQuery({
    queryKey: ['artist', userId, id],
    queryFn: () => getItem(userId, id!),
    enabled: !!userId && !!id,
  });

  const { data: albums, isLoading } = useQuery({
    queryKey: ['artist-albums', userId, id],
    queryFn: () => getArtistAlbums(userId, id!),
    enabled: !!userId && !!id,
  });

  async function handlePlayAlbum(albumId: string) {
    const tracks = await getAlbumTracks(userId, albumId);
    if (tracks.length > 0) {
      playQueue(tracks, 0);
    }
  }

  const artistImageUrl = id ? buildImageUrl(id, 300) : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end gap-6">
        <Artwork
          src={artistImageUrl}
          alt="Artist"
          className="h-48 w-48 rounded-full shadow-lg"
          iconClassName="h-16 w-16"
        />
        <div className="flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Artist
          </p>
          <h1 className="text-4xl font-bold">{artist?.Name || 'Artist'}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {albums?.length || 0} albums
          </p>
        </div>
      </div>

      {/* Albums */}
      {isLoading ? (
        <LoadingSkeleton />
      ) : !albums || albums.length === 0 ? (
        <EmptyState
          title="No albums found"
          description="This artist has no albums in your library"
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {albums.map((album) => {
            const albumImageUrl = buildImageUrl(album.Id, 300);
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
                    src={albumImageUrl}
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
                <div className="cursor-pointer" onClick={() => navigate(`/album/${album.Id}`)}>
                  <p className="truncate text-sm font-medium">{album.Name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {String(album.ProductionYear ?? 'Album')}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/store/playerStore';
import type { Track } from '@/store/playerStore';
import {
  searchMusic,
  buildImageUrl,
  buildTrackImageUrl,
  getAlbumTracks,
  type JellyfinItem,
} from '@/api/jellyfin';
import { Artwork } from '@/components/common/Artwork';
import { LoadingSkeleton } from '@/components/common/LoadingSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import LikeButton from '@/components/common/LikeButton';
import { Play } from 'lucide-react';

export default function Search() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const query = searchParams.get('q') || '';
  const userId = useAuthStore((state) => state.userId);
  const playQueue = usePlayerStore((state) => state.playQueue);
  const playSingle = usePlayerStore((state) => state.playSingle);

  const { data: results, isLoading } = useQuery({
    queryKey: ['search', userId, query],
    queryFn: () => searchMusic(userId, query),
    enabled: !!userId && query.length > 0,
  });

  function handlePlayTrack(track: JellyfinItem) {
    playSingle(track as Track);
  }

  async function handlePlayAlbum(albumId: string) {
    try {
      const tracks = await getAlbumTracks(userId, albumId);
      if (tracks.length > 0) {
        playQueue(tracks, 0);
      }
    } catch (error) {
      console.error('Failed to load album tracks', error);
      toast.error('Could not load album tracks');
    }
  }

  if (!query) {
    return (
      <EmptyState
        title="Search your library"
        description="Search for songs, albums, and more"
      />
    );
  }

  const audioResults = results?.filter((r) => r.Type === 'Audio') || [];
  const albumResults = results?.filter((r) => r.Type === 'MusicAlbum') || [];

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">
        Results for &ldquo;{query}&rdquo;
      </h1>

      {isLoading ? (
        <LoadingSkeleton />
      ) : !results || results.length === 0 ? (
        <EmptyState
          title="No results found"
          description={`Nothing matches "${query}" in your library`}
        />
      ) : (
        <>
          {/* Songs */}
          {audioResults.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Songs</h2>
              <div className="space-y-1">
                {audioResults.map((track, index) => {
                  const imageUrl = buildTrackImageUrl(track, 100);
                  return (
                    <div
                      key={track.Id}
                      className="group flex cursor-pointer items-center gap-4 rounded-md px-4 py-2 transition-colors hover:bg-secondary/50"
                      onClick={() => void handlePlayTrack(track)}
                    >
                      <span className="w-8 text-center text-sm tabular-nums text-muted-foreground">
                        {index + 1}
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
                          <p className="truncate text-sm">{track.Name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {track.Artists?.[0] || track.AlbumArtist || 'Unknown Artist'}
                          </p>
                        </div>
                      </div>
                      <span className="w-40 truncate text-sm text-muted-foreground">
                        {track.Album || '—'}
                      </span>
                      <LikeButton
                        itemId={track.Id}
                        isFavorite={!!track.UserData?.IsFavorite}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Albums */}
          {albumResults.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Albums</h2>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {albumResults.map((album) => {
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
                      <div
                        className="cursor-pointer"
                        onClick={() => navigate(`/album/${album.Id}`)}
                      >
                        <p className="truncate text-sm font-medium">{album.Name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {album.AlbumArtist || album.Artists?.[0] || 'Album'}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
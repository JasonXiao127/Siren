import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Home, ListMusic, Disc3, Heart, Plus, X, Check } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { getPlaylists, createPlaylist, buildImageUrl } from '@/api/jellyfin';
import { Artwork } from '@/components/common/Artwork';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export default function Sidebar() {
  const userId = useAuthStore((state) => state.userId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isCreating, setIsCreating] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');

  const { data: playlists, isLoading } = useQuery({
    queryKey: ['playlists', userId],
    queryFn: () => getPlaylists(userId),
    enabled: !!userId,
  });

  async function handleCreatePlaylist() {
    const name = newPlaylistName.trim();
    if (!name || !userId) return;

    try {
      const newId = await createPlaylist(userId, name);
      await queryClient.invalidateQueries({ queryKey: ['playlists'] });
      setNewPlaylistName('');
      setIsCreating(false);
      navigate(`/playlist/${newId}`);
    } catch {
      toast.error('Could not create playlist');
      // Keep the input open so the user can retry
    }
  }

  return (
    <div className="flex h-full flex-col gap-6 p-4">
      {/* Navigation */}
      <nav className="space-y-1">
        <NavLink
          to="/"
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
            )
          }
        >
          <Home className="h-4 w-4" />
          Home
        </NavLink>
        <NavLink
          to="/albums"
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
            )
          }
        >
          <Disc3 className="h-4 w-4" />
          Albums
        </NavLink>
        <NavLink
          to="/favorites"
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
            )
          }
        >
          <Heart className="h-4 w-4" />
          Liked Songs
        </NavLink>
      </nav>

      {/* Playlists */}
      <div className="flex-1 overflow-y-auto">
        <div className="mb-2 flex items-center gap-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <ListMusic className="h-3.5 w-3.5" />
          Your Playlists
          <button
            onClick={() => setIsCreating((v) => !v)}
            className="ml-auto flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Create playlist"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {isCreating && (
          <div className="mb-2 flex items-center gap-2 px-3">
            <input
              autoFocus
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreatePlaylist();
                if (e.key === 'Escape') {
                  setIsCreating(false);
                  setNewPlaylistName('');
                }
              }}
              placeholder="Playlist name"
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
            />
            <button
              onClick={() => void handleCreatePlaylist()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              title="Create"
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              onClick={() => {
                setIsCreating(false);
                setNewPlaylistName('');
              }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              title="Cancel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2 px-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {playlists?.map((playlist) => {
              const hasImage = playlist.ImageTags?.Primary;
              const imageUrl = hasImage
                ? buildImageUrl(playlist.Id, 100)
                : null;

              return (
                <NavLink
                  key={playlist.Id}
                  to={`/playlist/${playlist.Id}`}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                      isActive
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                    )
                  }
                >
                  <Artwork
                    src={imageUrl}
                    alt={playlist.Name}
                    className="h-10 w-10 rounded"
                    iconClassName="h-4 w-4"
                  />
                  <span className="truncate">{playlist.Name}</span>
                </NavLink>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
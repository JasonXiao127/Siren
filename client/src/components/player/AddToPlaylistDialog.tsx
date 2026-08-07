import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Check } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import {
  getPlaylists,
  createPlaylist,
  addTracksToPlaylist,
  getPlaylistTracks,
} from '@/api/jellyfin';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface AddToPlaylistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Track IDs to add to a playlist */
  trackIds: string[];
  /** Playlist ID to exclude from the list (e.g. the current playlist) */
  excludePlaylistId?: string;
}

export default function AddToPlaylistDialog({
  open,
  onOpenChange,
  trackIds,
  excludePlaylistId,
}: AddToPlaylistDialogProps) {
  const userId = useAuthStore((state) => state.userId);
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  const { data: playlists } = useQuery({
    queryKey: ['playlists', userId],
    queryFn: () => getPlaylists(userId!),
    enabled: !!userId && open,
  });

  // Reset selected playlist when the dialog reopens
  const availablePlaylists = useMemo(
    () => (playlists || []).filter((p) => p.Id !== excludePlaylistId),
    [playlists, excludePlaylistId]
  );

  function reset() {
    setSelectedId(null);
    setNewName('');
    setIsAdding(false);
  }

  async function handleAddToSelected() {
    if (!userId || !selectedId || trackIds.length === 0) return;
    setIsAdding(true);
    try {
      const existing = await getPlaylistTracks(userId, selectedId);
      const existingIds = new Set(existing.map((t) => t.Id));
      const newIds = trackIds.filter((id) => !existingIds.has(id));
      if (newIds.length === 0) {
        toast.success('Already in that playlist');
        onOpenChange(false);
        reset();
        return;
      }
      await addTracksToPlaylist(userId, selectedId, newIds);
      await queryClient.invalidateQueries({ queryKey: ['playlists'] });
      // Invalidate all playlist-tracks queries so open playlist pages refresh
      await queryClient.invalidateQueries({ queryKey: ['playlist-tracks'] });
      toast.success(`Added ${newIds.length} song${newIds.length > 1 ? 's' : ''}`);
      onOpenChange(false);
      reset();
    } catch (error) {
      console.error('Failed to add tracks to playlist', error);
      toast.error('Could not add songs to playlist');
    } finally {
      setIsAdding(false);
    }
  }

  async function handleCreateAndAdd() {
    if (!userId || !newName.trim() || trackIds.length === 0) return;
    setIsAdding(true);
    try {
      const newId = await createPlaylist(userId, newName.trim());
      await addTracksToPlaylist(userId, newId, trackIds);
      await queryClient.invalidateQueries({ queryKey: ['playlists'] });
      toast.success(`Created "${newName.trim()}" and added songs`);
      onOpenChange(false);
      reset();
    } catch (error) {
      console.error('Failed to create playlist and add tracks', error);
      toast.error('Could not create playlist');
    } finally {
      setIsAdding(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add to playlist</DialogTitle>
          <DialogDescription>
            {trackIds.length === 1
              ? 'Add this song to a playlist'
              : `Add ${trackIds.length} songs to a playlist`}
          </DialogDescription>
        </DialogHeader>

        {/* Existing playlists */}
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Playlists
          </p>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {availablePlaylists.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                No playlists yet — create one below.
              </p>
            ) : (
              availablePlaylists.map((playlist) => {
                const isSelected = playlist.Id === selectedId;
                return (
                  <button
                    key={playlist.Id}
                    onClick={() => setSelectedId(isSelected ? null : playlist.Id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
                      isSelected
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                    )}
                  >
                    <span className="truncate flex-1">{playlist.Name}</span>
                    {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                );
              })
            )}
          </div>
          <Button
            size="sm"
            className="w-full"
            disabled={!selectedId || isAdding}
            onClick={() => void handleAddToSelected()}
          >
            {isAdding ? 'Adding…' : 'Add to selected playlist'}
          </Button>
        </div>

        <div className="my-1 border-t border-border" />

        {/* Create new playlist */}
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            New playlist
          </p>
          <div className="flex items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateAndAdd();
              }}
              placeholder="Playlist name"
            />
            <Button
              size="icon"
              disabled={!newName.trim() || isAdding}
              onClick={() => void handleCreateAndAdd()}
              title="Create and add songs"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
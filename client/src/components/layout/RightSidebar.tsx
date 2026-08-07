import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { usePlayerStore, type Track } from '@/store/playerStore';
import { buildTrackImageUrl } from '@/api/jellyfin';
import { Artwork } from '@/components/common/Artwork';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/EmptyState';
import { X, Trash2, ListMusic, Play } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RightSidebarProps {
  open: boolean;
}

interface SortableTrackProps {
  track: Track;
  index: number;
  isCurrent: boolean;
  onRemove: (index: number) => void;
  onPlay: (index: number) => void;
}

function SortableTrack({ track, index, isCurrent, onRemove, onPlay }: SortableTrackProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `${track.Id}-${index}` });

  const imageUrl = buildTrackImageUrl(track, 100);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group flex items-center gap-3 rounded-md p-2 transition-colors',
        isDragging ? 'z-50 bg-secondary opacity-80' : '',
        isCurrent ? 'bg-secondary' : 'hover:bg-secondary/50'
      )}
    >
      <div {...attributes} {...listeners} className="cursor-grab touch-none">
        <Play className="h-3.5 w-3.5 text-muted-foreground/50 rotate-90" />
      </div>

      <div
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
        onClick={() => onPlay(index)}
      >
        <div className="relative">
          <Artwork
            src={imageUrl}
            alt={track.Name}
            className="h-10 w-10 rounded"
            iconClassName="h-4 w-4"
            objectFit="contain"
          />
          {isCurrent && (
            <div className="absolute inset-0 flex items-center justify-center rounded bg-black/50">
              <Play className="h-4 w-4 fill-current" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'truncate text-sm',
              isCurrent ? 'text-primary' : 'text-foreground'
            )}
          >
            {track.Name}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {track.Artists?.[0] || track.AlbumArtist || 'Unknown Artist'}
          </p>
        </div>
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={() => onRemove(index)}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export default function RightSidebar({ open }: RightSidebarProps) {
  const queue = usePlayerStore((state) => state.queue);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const removeFromQueue = usePlayerStore((state) => state.removeFromQueue);
  const clearQueue = usePlayerStore((state) => state.clearQueue);
  const reorderQueue = usePlayerStore((state) => state.reorderQueue);
  const jumpTo = usePlayerStore((state) => state.jumpTo);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const fromIndex = queue.findIndex(
      (t, i) => `${t.Id}-${i}` === active.id
    );
    const toIndex = queue.findIndex(
      (t, i) => `${t.Id}-${i}` === over.id
    );

    if (fromIndex >= 0 && toIndex >= 0 && fromIndex !== toIndex) {
      reorderQueue(fromIndex, toIndex);
    }
  }

  if (!open) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="flex items-center gap-2">
          <ListMusic className="h-4 w-4" />
          <h2 className="text-sm font-semibold">Up Next</h2>
        </div>
        {queue.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearQueue}
            className="h-7 gap-1 text-xs text-muted-foreground"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {queue.length === 0 ? (
          <EmptyState
            title="Queue is empty"
            description="Play a song to add it to the queue"
            className="py-8"
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={queue.map((t, i) => `${t.Id}-${i}`)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-1">
                {queue.map((track, index) => (
                  <SortableTrack
                    key={`${track.Id}-${index}`}
                    track={track}
                    index={index}
                    isCurrent={index === currentIndex}
                    onRemove={removeFromQueue}
                    onPlay={jumpTo}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}
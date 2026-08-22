import { useEffect } from 'react';
import { usePlayerStore } from '@/store/playerStore';
import { buildTrackImageUrl } from '@/api/jellyfin';
import { Artwork } from '@/components/common/Artwork';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { useAudioPlayer } from '@/components/player/useAudioPlayer';
import RightSidebar from '@/components/layout/RightSidebar';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Volume2,
  VolumeX,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ExpandedPlayerProps {
  open: boolean;
  onClose: () => void;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function ExpandedPlayer({ open, onClose }: ExpandedPlayerProps) {
  const queue = usePlayerStore((state) => state.queue);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const volume = usePlayerStore((state) => state.volume);
  const shuffle = usePlayerStore((state) => state.shuffle);
  const repeatMode = usePlayerStore((state) => state.repeatMode);
  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const next = usePlayerStore((state) => state.next);
  const previous = usePlayerStore((state) => state.previous);
  const setVolume = usePlayerStore((state) => state.setVolume);
  const setShuffle = usePlayerStore((state) => state.setShuffle);
  const setRepeatMode = usePlayerStore((state) => state.setRepeatMode);

  const { currentTime, duration, isMuted, seek, startSeek, endSeek, toggleMute } = useAudioPlayer();

  function handleSeek(value: number[]) {
    seek(value[0]);
  }

  const currentTrack = currentIndex >= 0 ? queue[currentIndex] : null;
  const imageUrl = currentTrack ? buildTrackImageUrl(currentTrack, 600) : null;

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Always render with transition classes so closing animates out.
  return (
    <div
      className={cn(
        'fixed inset-0 z-40 flex flex-col overflow-hidden bg-background transition-all duration-300 ease-out',
        open
          ? 'pointer-events-auto translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-8 opacity-0'
      )}
      aria-hidden={!open}
    >
      {/* Header row: window drag strip + collapse. The row is a drag region
          (the TopBar's is disabled while this overlay is open); the button
          opts out so it stays clickable. */}
      <div className="app-drag flex shrink-0 items-center justify-between px-4 py-3">
        <button
          onClick={onClose}
          className="app-no-drag flex items-center gap-1 rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ChevronDown className="h-4 w-4" />
          Collapse
        </button>
      </div>

      {/* Main content.
          Landscape (default): stacked — artwork/controls on top, queue fills a
          centered column below (slightly wider than the artwork section).
          Portrait: two-column — artwork/controls left, queue right. */}
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col portrait:max-w-none portrait:flex-row">
        {/* Artwork + controls column */}
        <div className="flex min-h-0 flex-col items-center justify-center gap-5 overflow-y-auto px-6 pb-6 pt-2 md:gap-6 portrait:flex-1">
          {/* Adaptive artwork — square album art or 16:9 thumbnail */}
          <Artwork
            src={imageUrl}
            alt={currentTrack?.Name || 'No track'}
            className="max-h-[40vh] w-fit shrink-0 rounded-lg shadow-2xl portrait:max-h-[50vh]"
            iconClassName="h-16 w-16"
            aspectRatio="auto"
          />

          {/* Song info */}
          <div className="min-w-0 text-center">
            <h2 className="truncate text-xl font-bold md:text-2xl">
              {currentTrack?.Name || 'Nothing playing'}
            </h2>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {currentTrack?.Artists?.[0] || currentTrack?.AlbumArtist || '—'}
            </p>
          </div>

          {/* Compact transport controls */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-9 w-9', shuffle && 'text-primary')}
              onClick={() => setShuffle(!shuffle)}
              title="Shuffle"
            >
              <Shuffle className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={previous} title="Previous">
              <SkipBack className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-12 w-12 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={togglePlay}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={next} title="Next">
              <SkipForward className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-9 w-9', repeatMode !== 'off' && 'text-primary')}
              onClick={() => {
                const modes = ['off', 'all', 'one'] as const;
                const idx = modes.indexOf(repeatMode);
                setRepeatMode(modes[(idx + 1) % modes.length]);
              }}
              title={`Repeat: ${repeatMode}`}
            >
              <Repeat className="h-5 w-5" />
            </Button>
          </div>

          {/* Progress */}
          <div className="flex w-full max-w-lg items-center gap-2">
            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
              {formatTime(currentTime)}
            </span>
            <Slider
              value={[currentTime]}
              max={duration || 0}
              step={0.5}
              onValueChange={handleSeek}
              onValueCommit={endSeek}
              onPointerDown={startSeek}
              className="flex-1"
              disabled={!currentTrack}
            />
            <span className="w-10 text-xs tabular-nums text-muted-foreground">
              {formatTime(duration)}
            </span>
          </div>

          {/* Volume */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={toggleMute}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </Button>
            <Slider
              value={[isMuted ? 0 : volume]}
              max={1}
              step={0.01}
              onValueChange={(v) => setVolume(v[0])}
              className="w-40"
            />
          </div>
        </div>

        {/* Queue column.
            Landscape: fills bottom width with a top border.
            Portrait: fixed-width right panel with a left border. */}
        <div className="flex min-h-0 w-full flex-1 flex-col border-t border-border portrait:w-[320px] portrait:flex-none portrait:border-l portrait:border-t-0 portrait:md:w-[380px]">
          <RightSidebar open />
        </div>
      </div>
    </div>
  );
}
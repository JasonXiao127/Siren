import { usePlayerStore } from '@/store/playerStore';
import { buildTrackImageUrl } from '@/api/jellyfin';
import { Artwork } from '@/components/common/Artwork';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { useAudioPlayer } from '@/components/player/useAudioPlayer';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Volume2,
  VolumeX,
  ListMusic,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface PlayerBarProps {
  onToggleQueue: () => void;
  queueOpen: boolean;
  onExpand: () => void;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function PlayerBar({ onToggleQueue, queueOpen, onExpand }: PlayerBarProps) {
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

  const currentTrack = currentIndex >= 0 ? queue[currentIndex] : null;
  const imageUrl = currentTrack ? buildTrackImageUrl(currentTrack, 100) : null;

  function handleVolumeChange(value: number[]) {
    setVolume(value[0]);
  }

  function handleMuteToggle() {
    toggleMute();
  }

  function handleSeek(value: number[]) {
    seek(value[0]);
  }

  return (
    <div className="flex h-full items-center gap-4 px-4">
      {/* Left: Track info — clicking this expands the player */}
      <div
        className="flex w-64 cursor-pointer items-center gap-3 rounded transition-colors hover:bg-secondary/50"
        onClick={onExpand}
        title="Expand player"
      >
        <Artwork
          src={imageUrl}
          alt={currentTrack?.Name || 'No track'}
          className="h-14 w-14 rounded"
          iconClassName="h-5 w-5"
          objectFit="contain"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {currentTrack?.Name || 'Nothing playing'}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {currentTrack?.Artists?.[0] || currentTrack?.AlbumArtist || '—'}
          </p>
        </div>
      </div>

      {/* Center: Controls + progress */}
      <div className="flex flex-1 flex-col items-center gap-1">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-8 w-8', shuffle && 'text-primary')}
            onClick={() => setShuffle(!shuffle)}
            title="Shuffle"
          >
            <Shuffle className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={previous}
            title="Previous"
          >
            <SkipBack className="h-5 w-5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={togglePlay}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={next}
            title="Next"
          >
            <SkipForward className="h-5 w-5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className={cn('h-8 w-8', repeatMode !== 'off' && 'text-primary')}
            onClick={() => {
              const modes = ['off', 'all', 'one'] as const;
              const idx = modes.indexOf(repeatMode);
              setRepeatMode(modes[(idx + 1) % modes.length]);
            }}
            title={`Repeat: ${repeatMode}`}
          >
            <Repeat className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex w-full max-w-xl items-center gap-2">
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
      </div>

      {/* Right: Volume + Queue */}
      <div className="flex w-64 items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleMuteToggle}
          title={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </Button>
        <Slider
          value={[isMuted ? 0 : volume]}
          max={1}
          step={0.01}
          onValueChange={handleVolumeChange}
          className="w-24"
        />
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-8 w-8', queueOpen && 'text-primary')}
          onClick={onToggleQueue}
          title="Toggle queue"
        >
          <ListMusic className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
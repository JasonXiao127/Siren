import { useEffect, useCallback, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { usePlayerStore } from '@/store/playerStore';
import { buildAudioUrl } from '@/api/jellyfin';

// ---------------------------------------------------------------------------
// Shared audio singleton.
//
// PlayerBar and ExpandedPlayer both mount useAudioPlayer(), so without this
// every hook instance would create its OWN new Audio() element — starting a
// duplicate stream to Jellyfin each time a track plays. All hook instances
// now reuse ONE module-level <audio> element and ONE set of listeners,
// subscriptions, media-session handlers, and keyboard shortcuts.
// ---------------------------------------------------------------------------

let sharedAudio: HTMLAudioElement | null = null;
let setupDone = false;

// Shared playback state (module scope + tiny pub/sub) so every hook instance
// stays in sync with the single audio element.
let currentTime = 0;
let duration = 0;
let isSeeking = false;
let muted = false;
const stateListeners = new Set<() => void>();

function emitState() {
  stateListeners.forEach((listener) => listener());
}

function subscribeToState(listener: () => void) {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

// Tracks the *intended* playing state so audio element events don't create a
// feedback loop with the store's isPlaying state.
let playIntent = false;

function getSharedAudio(): HTMLAudioElement {
  if (!sharedAudio) {
    sharedAudio = new Audio();
    sharedAudio.preload = 'none';
    sharedAudio.volume = usePlayerStore.getState().volume;
    sharedAudio.muted = muted;
  }

  if (!setupDone) {
    setupDone = true;
    attachAudioListeners(sharedAudio);
    attachStoreSubscriptions();
    attachMediaSession();
    attachKeyboardShortcuts();

    // One-time click listener to re-apply volume in case an autoplay policy
    // blocked the initial volume assignment.
    const applyVolume = () => {
      if (sharedAudio) sharedAudio.volume = usePlayerStore.getState().volume;
      document.removeEventListener('click', applyVolume);
    };
    document.addEventListener('click', applyVolume);
  }

  return sharedAudio;
}

function loadTrack(audio: HTMLAudioElement) {
  const { queue, currentIndex, setPlaying } = usePlayerStore.getState();
  const track = queue[currentIndex];

  if (!track) {
    // Queue cleared / no current track — stop whatever is playing.
    playIntent = false;
    audio.pause();
    audio.src = '';
    audio.load();
    return;
  }

  // Skip reloading if this is already the loaded track (e.g. queue reorder,
  // remove-from-queue, or clicking the same track again).
  if (audio.dataset.currentTrackId === track.Id) return;

  const url = buildAudioUrl(track.Id);

  // Explicit track-change sequence to avoid stale states
  audio.pause();
  audio.src = '';
  audio.load();
  audio.src = url;
  audio.dataset.currentTrackId = track.Id;
  playIntent = true;
  audio.play().catch(() => {
    // Autoplay may be blocked; user will need to click play
    playIntent = false;
    setPlaying(false);
  });
}

function attachAudioListeners(audio: HTMLAudioElement) {
  audio.addEventListener('timeupdate', () => {
    if (isSeeking) return;
    currentTime = audio.currentTime;
    emitState();
  });

  audio.addEventListener('loadedmetadata', () => {
    duration = audio.duration;
    emitState();
  });

  audio.addEventListener('ended', () => {
    const { repeatMode, next, setPlaying } = usePlayerStore.getState();

    if (repeatMode === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => setPlaying(false));
      return;
    }

    // Clear the "current" marker before advancing so the track-change
    // subscription forces a fresh reload even if the queue lands back on
    // the same track (e.g. repeat-all with a single-track queue).
    audio.dataset.currentTrackId = '';
    next();
  });

  // Track consecutive errors to avoid an infinite skip loop if every
  // track in the queue fails (e.g. server unreachable).
  let consecutiveErrors = 0;
  audio.addEventListener('error', () => {
    consecutiveErrors += 1;
    const { setPlaying, next } = usePlayerStore.getState();
    if (consecutiveErrors >= 3) {
      toast.error('Multiple tracks failed to play — stopping');
      setPlaying(false);
      consecutiveErrors = 0;
      return;
    }
    toast.error('Failed to play track — skipping to next');
    next();
  });

  // Successful playback start clears the strike counter — transient failures
  // must not accumulate forever across otherwise healthy tracks.
  audio.addEventListener('playing', () => {
    consecutiveErrors = 0;
  });

  // Sync the store's isPlaying state with the audio element's actual state,
  // but only when it matches the intended state. This prevents a feedback
  // loop where the audio element's pause event (e.g. during buffering)
  // flips isPlaying to false, which then calls audio.pause(), etc.
  audio.addEventListener('play', () => {
    if (playIntent) usePlayerStore.getState().setPlaying(true);
  });
  audio.addEventListener('pause', () => {
    if (!playIntent) usePlayerStore.getState().setPlaying(false);
  });
}

function attachStoreSubscriptions() {
  // Track change: load a new source only when the actual current track changes.
  usePlayerStore.subscribe((state, prev) => {
    if (!sharedAudio) return;
    if (state.queue === prev.queue && state.currentIndex === prev.currentIndex) return;
    loadTrack(sharedAudio);
  });

  // Play/pause control
  usePlayerStore.subscribe((state, prev) => {
    if (!sharedAudio || state.isPlaying === prev.isPlaying) return;
    playIntent = state.isPlaying;
    if (state.isPlaying) {
      sharedAudio.play().catch(() => {
        playIntent = false;
        usePlayerStore.getState().setPlaying(false);
      });
    } else {
      sharedAudio.pause();
    }
  });

  // Volume control
  usePlayerStore.subscribe((state, prev) => {
    if (!sharedAudio || state.volume === prev.volume) return;
    sharedAudio.volume = state.volume;
  });
}

function attachMediaSession() {
  if (!('mediaSession' in navigator)) return;

  let lastTrackId: string | undefined;

  const updateMetadata = () => {
    const { queue, currentIndex } = usePlayerStore.getState();
    const track = queue[currentIndex];
    if (track?.Id === lastTrackId) return;
    lastTrackId = track?.Id;
    if (!track) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.Name,
      artist: track.Artists?.[0] || track.AlbumArtist || 'Unknown Artist',
      album: track.Album || '',
    });
  };

  updateMetadata();
  usePlayerStore.subscribe(updateMetadata);

  navigator.mediaSession.setActionHandler('play', () => {
    playIntent = true;
    getSharedAudio()
      .play()
      .catch(() => {
        playIntent = false;
        usePlayerStore.getState().setPlaying(false);
      });
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    playIntent = false;
    getSharedAudio().pause();
  });
  navigator.mediaSession.setActionHandler('nexttrack', () => usePlayerStore.getState().next());
  navigator.mediaSession.setActionHandler('previoustrack', () => usePlayerStore.getState().previous());
}

function attachKeyboardShortcuts() {
  const handler = (e: KeyboardEvent) => {
    // Don't trigger when typing in inputs or contenteditable elements
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    ) {
      return;
    }

    const audio = getSharedAudio();

    if (e.code === 'Space') {
      e.preventDefault();
      // No queue → nothing to play; toggling would flip a phantom isPlaying
      // state that the audio element can never satisfy.
      if (usePlayerStore.getState().queue.length > 0) {
        usePlayerStore.getState().togglePlay();
      }
    } else if (e.key === 'ArrowRight') {
      audio.currentTime = Math.min(audio.currentTime + 5, audio.duration || 0);
      currentTime = audio.currentTime;
      emitState();
    } else if (e.key === 'ArrowLeft') {
      audio.currentTime = Math.max(audio.currentTime - 5, 0);
      currentTime = audio.currentTime;
      emitState();
    } else if (e.key === 'm' || e.key === 'M') {
      setMuted(!muted);
    }
  };

  window.addEventListener('keydown', handler);
}

function setMuted(value: boolean) {
  if (muted === value) return;
  muted = value;
  if (sharedAudio) sharedAudio.muted = value;
  emitState();
}

export function useAudioPlayer() {
  // Ensure the shared element + one-time setup exist. Idempotent — the
  // element and listeners persist for the lifetime of the page, so music
  // keeps playing across route changes.
  useEffect(() => {
    getSharedAudio();
  }, []);

  const currentTimeSnapshot = useSyncExternalStore(subscribeToState, () => currentTime);
  const durationSnapshot = useSyncExternalStore(subscribeToState, () => duration);
  const isSeekingSnapshot = useSyncExternalStore(subscribeToState, () => isSeeking);
  const isMutedSnapshot = useSyncExternalStore(subscribeToState, () => muted);

  const seek = useCallback((time: number) => {
    const audio = getSharedAudio();
    audio.currentTime = time;
    currentTime = time;
    emitState();
  }, []);

  const startSeek = useCallback(() => {
    isSeeking = true;
    emitState();
  }, []);

  const endSeek = useCallback(() => {
    isSeeking = false;
    emitState();
  }, []);

  const toggleMute = useCallback(() => {
    setMuted(!muted);
  }, []);

  return {
    currentTime: currentTimeSnapshot,
    duration: durationSnapshot,
    isSeeking: isSeekingSnapshot,
    isMuted: isMutedSnapshot,
    seek,
    startSeek,
    endSeek,
    toggleMute,
  };
}
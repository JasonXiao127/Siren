import { useEffect, useCallback, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { usePlayerStore } from '@/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { withBase } from '@/lib/base';
import {
  buildAudioUrl,
  buildTrackImageUrl,
  reportPlaybackStart,
  reportPlaybackProgress,
  reportPlaybackStopped,
  secondsToTicks,
  toJellyfinRepeatMode,
  type PlaybackReportInfo,
} from '@/api/jellyfin';

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

// Generation counter: guards async play() rejections on fast skips so a
// stale rejection from track A can't pause freshly-loaded track B.
let loadGeneration = 0;

// ---------------------------------------------------------------------------
// Jellyfin playback reporting.
//
// One PlaySessionId per track playback, reported via the modern
// ReportPlaybackStart/Progress/Stopped endpoints so play counts,
// recently-played ordering, resume state, and the dashboard "Now Playing"
// indicator stay accurate. Every report is fire-and-forget and resolves
// silently on failure — reporting must never interrupt audio.
// ---------------------------------------------------------------------------

let playSessionId: string | null = null;
let lastProgressReportAt = 0;
const PROGRESS_INTERVAL_MS = 15000;

function newPlaySessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the Math.random fallback below.
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function currentReportInfo(
  trackId: string,
  positionSeconds: number,
  extra?: { isPaused?: boolean }
): PlaybackReportInfo | null {
  // No session (logged out, or nothing playing) — nothing to report.
  if (!useAuthStore.getState().userId || !playSessionId) return null;
  const { volume, repeatMode } = usePlayerStore.getState();
  const clampedVolume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.8;
  return {
    itemId: trackId,
    playSessionId,
    positionTicks: secondsToTicks(positionSeconds),
    volumeLevel: Math.round(clampedVolume * 100),
    isMuted: muted,
    repeatMode: toJellyfinRepeatMode(repeatMode),
    ...extra,
  };
}

/**
 * Reports playback-stopped for whatever track the element currently holds
 * and retires its PlaySessionId. Also clears the "current" marker so a
 * subsequent loadTrack() always performs a fresh load. Uses the element's
 * live position (not the throttled module clock) so skip/end positions are exact.
 */
function stopPreviousPlayback(audio: HTMLAudioElement): void {
  const previousId = audio.dataset.currentTrackId;
  audio.dataset.currentTrackId = '';
  if (previousId && playSessionId) {
    const info = currentReportInfo(previousId, Number.isFinite(audio.currentTime) ? audio.currentTime : currentTime);
    if (info) void reportPlaybackStopped(info);
  }
  playSessionId = null;
}

function reportProgressForCurrentAudio(audio: HTMLAudioElement, isPaused: boolean): void {
  const id = audio.dataset.currentTrackId;
  if (!id || !playSessionId) return;
  lastProgressReportAt = Date.now();
  const pos = Number.isFinite(audio.currentTime) ? audio.currentTime : currentTime;
  const info = currentReportInfo(id, pos, { isPaused });
  if (info) void reportPlaybackProgress(info);
}

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

function loadTrack(audio: HTMLAudioElement, forceReload = false) {
  const { queue, currentIndex, setPlaying } = usePlayerStore.getState();
  const track = queue[currentIndex];

  // Skip reloading if this is already the loaded track (e.g. queue reorder,
  // remove-from-queue). forceReload bypasses this for explicit replay
  // (click current track, Previous at start).
  if (track && audio.dataset.currentTrackId === track.Id && !forceReload) return;

  // Retire the previous session (reports stopped) before starting the next.
  stopPreviousPlayback(audio);
  // Reset the clock so the slider doesn't show the previous track's time.
  currentTime = 0;
  duration = 0;
  emitState();

  if (!track) {
    // Queue cleared / no current track — stop whatever is playing.
    playIntent = false;
    loadGeneration += 1;
    audio.pause();
    audio.src = '';
    audio.load();
    return;
  }

  const url = buildAudioUrl(track.Id);

  // Explicit track-change sequence to avoid stale states
  const generation = ++loadGeneration;
  audio.pause();
  audio.src = '';
  audio.load();
  audio.src = url;
  audio.dataset.currentTrackId = track.Id;
  playSessionId = newPlaySessionId();
  lastProgressReportAt = Date.now();
  const startInfo = currentReportInfo(track.Id, 0, { isPaused: false });
  if (startInfo) void reportPlaybackStart(startInfo);
  playIntent = true;
  audio.play().catch(() => {
    // Autoplay may be blocked; user will need to click play.
    // Guarded: ignore stale rejections from a superseded load.
    if (generation !== loadGeneration) return;
    playIntent = false;
    setPlaying(false);
  });
}

function attachAudioListeners(audio: HTMLAudioElement) {
  audio.addEventListener('timeupdate', () => {
    if (isSeeking) return;
    currentTime = audio.currentTime;
    // Throttled progress reports keep the dashboard position fresh without
    // spamming the server on every frame.
    const now = Date.now();
    if (playIntent && now - lastProgressReportAt >= PROGRESS_INTERVAL_MS) {
      lastProgressReportAt = now;
      const id = audio.dataset.currentTrackId;
      if (id) {
        const info = currentReportInfo(id, currentTime, { isPaused: false });
        if (info) void reportPlaybackProgress(info);
      }
    }
    emitState();
  });

  audio.addEventListener('loadedmetadata', () => {
    duration = audio.duration;
    emitState();
  });

  audio.addEventListener('ended', () => {
    const { repeatMode, next, setPlaying } = usePlayerStore.getState();

    if (repeatMode === 'one') {
      // Each loop is a new play server-side (play counts, recently-played).
      // Retire the old session and start a fresh one instead of replaying
      // under the same PlaySessionId forever.
      const id = audio.dataset.currentTrackId;
      stopPreviousPlayback(audio);
      if (!id) {
        next();
        return;
      }
      audio.src = buildAudioUrl(id);
      audio.dataset.currentTrackId = id;
      playSessionId = newPlaySessionId();
      lastProgressReportAt = Date.now();
      currentTime = 0;
      emitState();
      const startInfo = currentReportInfo(id, 0, { isPaused: false });
      if (startInfo) void reportPlaybackStart(startInfo);
      playIntent = true;
      const generation = ++loadGeneration;
      audio.play().catch(() => {
        if (generation !== loadGeneration) return;
        playIntent = false;
        setPlaying(false);
      });
      return;
    }

    // Natural track end completes the session server-side (play counts,
    // resume). stopPreviousPlayback also clears the "current" marker so the
    // track-change subscription forces a fresh reload even if the queue lands
    // back on the same track (e.g. repeat-all with a single-track queue).
    stopPreviousPlayback(audio);
    next();
  });

  // Track consecutive errors to avoid an infinite skip loop if every
  // track in the queue fails (e.g. server unreachable).
  let consecutiveErrors = 0;
  audio.addEventListener('error', () => {
    consecutiveErrors += 1;
    // Retire the failed session before advancing so it isn't left dangling.
    stopPreviousPlayback(audio);
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
    if (!playIntent) {
      usePlayerStore.getState().setPlaying(false);
      // timeupdate stops firing while paused, so report the paused position
      // explicitly (no-op when nothing is loaded — marker is empty then).
      // Sync the module clock too so a subsequent Stopped uses the exact spot.
      currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : currentTime;
      reportProgressForCurrentAudio(audio, true);
    }
  });
  audio.addEventListener('seeked', () => {
    currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : currentTime;
    emitState();
  });
}

function attachStoreSubscriptions() {
  // Track change: load a new source only when the actual current track changes,
  // or when playNonce bumps (explicit replay of the same track).
  usePlayerStore.subscribe((state, prev) => {
    if (!sharedAudio) return;
    const trackChanged =
      state.queue !== prev.queue || state.currentIndex !== prev.currentIndex;
    const replayRequested = state.playNonce !== prev.playNonce;
    if (!trackChanged && !replayRequested) return;
    loadTrack(sharedAudio, replayRequested && !trackChanged);
  });

  // End-of-queue stop (repeat off, user pressed Next on last track): retire
  // the session server-side. Distinct from pause (which sends Progress).
  usePlayerStore.subscribe((state, prev) => {
    if (!sharedAudio || state.stopRequestId === prev.stopRequestId) return;
    stopPreviousPlayback(sharedAudio);
    playIntent = false;
    currentTime = 0;
    emitState();
  });

  // Play/pause control
  usePlayerStore.subscribe((state, prev) => {
    if (!sharedAudio || state.isPlaying === prev.isPlaying) return;
    playIntent = state.isPlaying;
    if (state.isPlaying) {
      const { queue, currentIndex } = usePlayerStore.getState();
      if (queue.length === 0) {
        // Nothing to play — revert the phantom toggle.
        playIntent = false;
        usePlayerStore.getState().setPlaying(false);
        return;
      }
      if (!sharedAudio.dataset.currentTrackId) {
        // Retired after end-of-queue stop (or fresh boot with persisted
        // index): reload the current track instead of deadlocking.
        const track = queue[currentIndex];
        if (!track) {
          playIntent = false;
          usePlayerStore.getState().setPlaying(false);
          return;
        }
        loadTrack(sharedAudio, true);
        return;
      }
      const generation = ++loadGeneration;
      sharedAudio.play().catch(() => {
        if (generation !== loadGeneration) return;
        playIntent = false;
        usePlayerStore.getState().setPlaying(false);
      });
    } else {
      sharedAudio.pause();
    }
  });

  // Volume control — push the new level so dashboard position/volume stays fresh.
  usePlayerStore.subscribe((state, prev) => {
    if (!sharedAudio || state.volume === prev.volume) return;
    sharedAudio.volume = state.volume;
    if (playIntent) reportProgressForCurrentAudio(sharedAudio, false);
  });

  // Best-effort Stopped on tab close/reload so dashboard "Now Playing"
  // doesn't stick. Uses sendBeacon (survives unload); falls back to fetch.
  window.addEventListener('beforeunload', () => {
    try {
      const audio = sharedAudio;
      const id = audio?.dataset.currentTrackId;
      if (!id || !playSessionId) return;
      const { userId } = useAuthStore.getState();
      if (!userId) return;
      const pos = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : currentTime;
      const body = JSON.stringify({
        ItemId: id,
        MediaSourceId: id,
        PlaySessionId: playSessionId,
        PositionTicks: secondsToTicks(pos),
      });
      // Report directly to the proxy path so it works even as axios tears down.
      // withBase-aware so subpath hosting (/siren) works.
      const url = withBase('/api/proxy/Sessions/Playing/Stopped');
      if (typeof navigator.sendBeacon === 'function') {
        try {
          // sendBeacon doesn't send cookies in all contexts; server will 401
          // and we ignore — still best-effort.
          navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
          return;
        } catch {
          // fall through
        }
      }
      void reportPlaybackStopped({
        itemId: id,
        playSessionId,
        positionTicks: secondsToTicks(pos),
      });
    } catch {
      // never block unload
    }
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
    let artwork: MediaImage[] | undefined;
    try {
      const artUrl = buildTrackImageUrl(track, 512);
      if (artUrl) artwork = [{ src: artUrl, sizes: '512x512', type: 'image/jpeg' }];
    } catch {
      artwork = undefined;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.Name,
      artist: track.Artists?.[0] || track.AlbumArtist || 'Unknown Artist',
      album: track.Album || '',
      ...(artwork ? { artwork } : {}),
    });
  };

  updateMetadata();
  usePlayerStore.subscribe(updateMetadata);

  navigator.mediaSession.setActionHandler('play', () => {
    playIntent = true;
    const generation = ++loadGeneration;
    getSharedAudio()
      .play()
      .catch(() => {
        if (generation !== loadGeneration) return;
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
      reportProgressForCurrentAudio(audio, !audio.paused && playIntent ? false : true);
    } else if (e.key === 'ArrowLeft') {
      audio.currentTime = Math.max(audio.currentTime - 5, 0);
      currentTime = audio.currentTime;
      emitState();
      reportProgressForCurrentAudio(audio, !audio.paused && playIntent ? false : true);
    } else if (e.key === 'm' || e.key === 'M') {
      setMuted(!muted);
    }
  };

  window.addEventListener('keydown', handler);
}

function setMuted(value: boolean) {
  if (muted === value) return;
  muted = value;
  if (sharedAudio) {
    sharedAudio.muted = value;
    if (playIntent) reportProgressForCurrentAudio(sharedAudio, false);
  }
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
    // A seek invalidates the server's last known position — report it
    // immediately rather than waiting for the next throttled tick.
    const id = getSharedAudio().dataset.currentTrackId;
    if (id && playSessionId) {
      lastProgressReportAt = Date.now();
      const info = currentReportInfo(id, currentTime, { isPaused: !playIntent });
      if (info) void reportPlaybackProgress(info);
    }
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
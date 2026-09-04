import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Track {
  Id: string;
  Name: string;
  AlbumId?: string;
  Album?: string;
  AlbumArtist?: string;
  Artists?: string[];
  RunTimeTicks?: number;
  IndexNumber?: number;
  /** Jellyfin playlist entry ID — needed to remove a specific song row from a playlist */
  PlaylistItemId?: string;
  ImageTags?: {
    Primary?: string;
    Thumb?: string;
  };
  UserData?: {
    IsFavorite?: boolean;
    PlayCount?: number;
    PlayedPercentage?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type RepeatMode = 'off' | 'all' | 'one';

interface PlayerState {
  queue: Track[];
  currentIndex: number;
  isPlaying: boolean;
  volume: number;
  shuffle: boolean;
  repeatMode: RepeatMode;
  playTrack: (track: Track, queue: Track[]) => void;
  playQueue: (queue: Track[], startIndex?: number) => void;
  playSingle: (track: Track) => void;
  jumpTo: (index: number) => void;
  playShuffled: (queue: Track[]) => void;
  next: () => void;
  previous: () => void;
  togglePlay: () => void;
  setVolume: (volume: number) => void;
  setShuffle: (shuffle: boolean) => void;
  setRepeatMode: (mode: RepeatMode) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  playNext: (track: Track) => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  setPlaying: (isPlaying: boolean) => void;
}

/**
 * Shuffles a queue in place while keeping the track at `currentIndex`
 * in its current position, so the currently playing track isn't interrupted.
 */
function shuffleQueue(queue: Track[], currentIndex: number): Track[] {
  if (queue.length <= 1) return [...queue];

  const shuffled = [...queue];

  if (currentIndex < 0) {
    // No current track — shuffle the entire queue
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  const [currentTrack] = shuffled.splice(currentIndex, 1);

  // Fisher–Yates shuffle the rest
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // Put the current track back at its original position
  shuffled.splice(currentIndex, 0, currentTrack);

  return shuffled;
}

/**
 * Shuffles the ENTIRE queue — no track is kept in place. Used when starting
 * a fresh shuffled playback so the first song is truly random.
 */
function shuffleEntireQueue(queue: Track[]): Track[] {
  if (queue.length <= 1) return [...queue];

  const shuffled = [...queue];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      queue: [],
      currentIndex: -1,
      isPlaying: false,
      volume: 0.8,
      shuffle: false,
      repeatMode: 'off',

      playTrack: (track, queue) =>
        set((state) => {
          const startIndex = queue.findIndex((t) => t.Id === track.Id);
          return {
            queue: state.shuffle ? shuffleQueue(queue, startIndex) : queue,
            currentIndex: startIndex,
            isPlaying: true,
          };
        }),

      playQueue: (queue, startIndex = 0) =>
        set((state) => ({
          // When shuffle is on, shuffle the ENTIRE queue and start at the top
          // of the shuffled order. The first song is therefore random, and the
          // player starts at index 0 rather than jumping to a random index.
          queue: state.shuffle ? shuffleEntireQueue(queue) : queue,
          currentIndex: state.shuffle ? 0 : startIndex,
          isPlaying: true,
        })),

      /**
       * Plays a single track by inserting it at the top of the queue
       * (right after the currently playing track) without clearing the
       * existing queue. Used for one-off plays from grids like Home.
       */
      playSingle: (track) =>
        set((state) => {
          const queue = [...state.queue];
          const insertAt = state.currentIndex + 1;
          queue.splice(insertAt, 0, track);
          return {
            queue,
            currentIndex: insertAt,
            isPlaying: true,
          };
        }),

      /**
       * Jumps to a specific index in the existing queue and starts playing
       * from that position. Used when clicking a track in the queue panel.
       */
      jumpTo: (index) =>
        set((state) => {
          if (index < 0 || index >= state.queue.length) return state;
          return { currentIndex: index, isPlaying: true };
        }),

      playShuffled: (queue) => {
        if (queue.length === 0) return;

        // Shuffle the ENTIRE queue — no track kept in place. The first track
        // is already random, so we start at index 0 instead of jumping the
        // player to a random index.
        const shuffled = shuffleEntireQueue(queue);

        set({
          queue: shuffled,
          currentIndex: 0,
          isPlaying: true,
          shuffle: true,
        });
      },

      next: () => {
        const { queue, currentIndex, shuffle, repeatMode } = get();
        if (queue.length === 0) return;

        // NOTE: no repeatMode === 'one' guard here — the audio hook handles
        // repeat-one before calling next() on natural track end. This
        // function is only reached by user intent (Next button, media keys,
        // error-skip), which must always advance.

        let nextIndex = currentIndex + 1;

        if (nextIndex >= queue.length) {
          if (repeatMode === 'all') {
            // Queue wrapped around — reshuffle if shuffle is on
            nextIndex = 0;
            if (shuffle) {
              set({
                queue: shuffleQueue(queue, nextIndex),
                currentIndex: nextIndex,
                isPlaying: true,
              });
              return;
            }
          } else {
            set({ isPlaying: false });
            return;
          }
        }

        set({ currentIndex: nextIndex, isPlaying: true });
      },

      previous: () => {
        const { queue, currentIndex } = get();
        if (queue.length === 0) return;

        let prevIndex = currentIndex - 1;
        if (prevIndex < 0) {
          prevIndex = queue.length - 1;
        }

        set({ currentIndex: prevIndex, isPlaying: true });
      },

      togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),

      setVolume: (volume) => set({ volume }),

      setShuffle: (shuffle) =>
        set((state) => {
          if (shuffle === state.shuffle) return state;

          if (shuffle) {
            // Shuffle the queue in place, keeping the current track put
            return {
              shuffle: true,
              queue: shuffleQueue(state.queue, state.currentIndex),
            };
          }

          // Turning shuffle off leaves the queue untouched
          return { shuffle: false };
        }),

      setRepeatMode: (repeatMode) => set({ repeatMode }),

      removeFromQueue: (index) =>
        set((state) => {
          const queue = [...state.queue];
          queue.splice(index, 1);

          let currentIndex = state.currentIndex;
          if (index < currentIndex) {
            currentIndex -= 1;
          } else if (index === currentIndex) {
            currentIndex = Math.min(currentIndex, queue.length - 1);
          }

          return { queue, currentIndex };
        }),

      clearQueue: () => set({ queue: [], currentIndex: -1, isPlaying: false }),

      playNext: (track) =>
        set((state) => {
          const queue = [...state.queue];
          const insertAt = state.currentIndex + 1;
          queue.splice(insertAt, 0, track);
          return { queue };
        }),

      reorderQueue: (fromIndex, toIndex) =>
        set((state) => {
          if (
            fromIndex < 0 ||
            toIndex < 0 ||
            fromIndex >= state.queue.length ||
            toIndex >= state.queue.length ||
            fromIndex === toIndex
          ) {
            return state;
          }

          const queue = [...state.queue];
          const [moved] = queue.splice(fromIndex, 1);
          queue.splice(toIndex, 0, moved);

          let currentIndex = state.currentIndex;
          if (fromIndex === currentIndex) {
            currentIndex = toIndex;
          } else if (fromIndex < currentIndex && toIndex >= currentIndex) {
            currentIndex -= 1;
          } else if (fromIndex > currentIndex && toIndex <= currentIndex) {
            currentIndex += 1;
          }

          return { queue, currentIndex };
        }),

      setPlaying: (isPlaying) => set({ isPlaying }),
    }),
    {
      name: 'siren-player',
      partialize: (state) => ({
        volume: state.volume,
        shuffle: state.shuffle,
        repeatMode: state.repeatMode,
      }),
    }
  )
);
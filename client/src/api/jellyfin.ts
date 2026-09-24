import { apiClient } from './client';
import { useAuthStore } from '@/store/authStore';
import { withBase } from '@/lib/base';
import type { Track } from '@/store/playerStore';

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  AlbumId?: string;
  Album?: string;
  AlbumArtist?: string;
  Artists?: string[];
  RunTimeTicks?: number;
  IndexNumber?: number;
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

export interface JellyfinItemsResponse {
  Items: JellyfinItem[];
  TotalRecordCount: number;
}

export interface JellyfinArtist {
  Id: string;
  Name: string;
  ImageTags?: {
    Primary?: string;
    Thumb?: string;
  };
  [key: string]: unknown;
}

export interface JellyfinArtistsResponse {
  Items: JellyfinArtist[];
  TotalRecordCount: number;
}

/**
 * Jellyfin responses are trusted only as far as their shape is verifiable —
 * a captive portal, proxy hiccup, or misbehaving server plugin must degrade
 * to an empty list rather than crash the renderer mid-render.
 */
function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// --- Auth ---

export interface LoginResponse {
  user: {
    id: string;
    name: string;
  };
  serverUrl: string;
}

export async function login(
  serverUrl: string,
  username: string,
  password: string,
  deviceId: string
): Promise<LoginResponse> {
  const response = await apiClient.post<LoginResponse>('/auth/login', {
    serverUrl,
    username,
    password,
    deviceId,
  });
  return response.data;
}

export async function logout(): Promise<void> {
  try {
    await apiClient.post('/auth/logout');
  } catch {
    // Ignore — the session cookie will expire on its own if the server is unreachable.
  }
}

// --- Data fetching ---

export async function getPlaylists(userId: string): Promise<JellyfinItem[]> {
  // Canonical Jellyfin 12 path: GET /Items?userId=… (the
  // /Users/{id}/Items form is legacy-only and hidden from the spec).
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Items', {
    params: {
      userId,
      IncludeItemTypes: 'Playlist',
      // Without Recursive, Jellyfin ignores IncludeItemTypes on this endpoint
      // and returns top-level library folders (Movies, TV Shows, Music, ...)
      // instead of actual playlists.
      Recursive: true,
      Limit: 100,
    },
  });
  return toArray(response.data?.Items);
}

export async function getPlaylistTracks(userId: string, playlistId: string): Promise<Track[]> {
  return getChildTracks(userId, playlistId);
}

export async function getRecentlyAdded(userId: string): Promise<Track[]> {
  const response = await apiClient.get<JellyfinItem[]>('/proxy/Items/Latest', {
    params: {
      userId,
      IncludeItemTypes: 'Audio',
      Limit: 24,
      Fields: 'PrimaryImageAspectRatio,DateCreated',
    },
  });
  return toArray<Track>(response.data);
}

export async function getAlbums(userId: string): Promise<JellyfinItem[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Items', {
    params: {
      userId,
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Limit: 200,
    },
  });
  return toArray(response.data?.Items);
}

export async function getFavorites(userId: string): Promise<Track[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Items', {
    params: {
      userId,
      Filters: 'IsFavorite',
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Limit: 200,
    },
  });
  return toArray<Track>(response.data?.Items);
}

export async function setFavorite(
  userId: string,
  itemId: string,
  isFavorite: boolean
): Promise<void> {
  if (isFavorite) {
    // Canonical Jellyfin 12 path (the /Users/{id}/FavoriteItems form is legacy).
    await apiClient.post(`/proxy/UserFavoriteItems/${itemId}`, null, {
      params: { userId },
    });
  } else {
    await apiClient.delete(`/proxy/UserFavoriteItems/${itemId}`, {
      params: { userId },
    });
  }
}

export async function getRecentlyPlayed(userId: string): Promise<Track[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Items', {
    params: {
      userId,
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
      Limit: 24,
      Fields: 'PrimaryImageAspectRatio',
    },
  });
  return toArray<Track>(response.data?.Items);
}

export async function getFrequentlyPlayed(userId: string): Promise<Track[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Items', {
    params: {
      userId,
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'PlayCount',
      SortOrder: 'Descending',
      Limit: 24,
      Fields: 'PrimaryImageAspectRatio',
    },
  });
  return toArray<Track>(response.data?.Items);
}

export async function createPlaylist(userId: string, name: string): Promise<string> {
  const response = await apiClient.post<{ Id: string }>('/proxy/Playlists', null, {
    params: {
      UserId: userId,
      Name: name,
    },
  });
  return response.data.Id;
}

export async function deletePlaylist(userId: string, playlistId: string): Promise<void> {
  try {
    await apiClient.delete(`/proxy/Playlists/${playlistId}`, {
      params: {
        UserId: userId,
      },
    });
  } catch (error) {
    // Some Jellyfin versions/instances reject the playlist-specific route.
    // Fall back to the generic item delete, which also works for playlists.
    await apiClient.delete(`/proxy/Items/${playlistId}`, {
      params: {
        UserId: userId,
      },
    });
  }
}

/**
 * Adds tracks to a playlist. Jellyfin silently ignores IDs that are already
 * in the playlist, but we cull duplicates client-side beforehand for a
 * cleaner UX (no partial-add surprises).
 */
export async function addTracksToPlaylist(
  userId: string,
  playlistId: string,
  trackIds: string[]
): Promise<void> {
  if (trackIds.length === 0) return;
  await apiClient.post(`/proxy/Playlists/${playlistId}/Items`, null, {
    params: {
      Ids: trackIds.join(','),
      UserId: userId,
    },
  });
}

/**
 * Removes specific playlist entries by their playlist-entry IDs
 * (track.PlaylistItemId). If no entry IDs are available, falls back to
 * removing by track Id (Jellyfin's older API shape).
 */
export async function removeTracksFromPlaylist(
  userId: string,
  playlistId: string,
  entryIds: string[]
): Promise<void> {
  if (entryIds.length === 0) return;
  await apiClient.delete(`/proxy/Playlists/${playlistId}/Items`, {
    params: {
      EntryIds: entryIds.join(','),
      UserId: userId,
    },
  });
}

export async function getArtists(userId: string): Promise<JellyfinArtist[]> {
  // Jellyfin 12 marks GET /Artists obsolete ("Use GetPersons") — it still
  // works, but Persons is the canonical path. PersonType values cover both
  // solo artists and album artists; the response shape ({Items}) is the same.
  const response = await apiClient.get<JellyfinArtistsResponse>('/proxy/Persons', {
    params: {
      userId,
      personTypes: 'Artist,AlbumArtist',
      Limit: 200,
    },
  });
  return toArray(response.data?.Items);
}

export async function searchMusic(userId: string, query: string): Promise<JellyfinItem[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Items', {
    params: {
      userId,
      searchTerm: query,
      IncludeItemTypes: 'Audio,MusicAlbum',
      Recursive: true,
      Limit: 50,
    },
  });
  return toArray(response.data?.Items);
}

export async function getAlbumTracks(userId: string, albumId: string): Promise<Track[]> {
  return getChildTracks(userId, albumId);
}

export async function getArtistAlbums(userId: string, artistId: string): Promise<JellyfinItem[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Items', {
    params: {
      userId,
      ArtistIds: artistId,
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      SortBy: 'ProductionYear',
      SortOrder: 'Ascending',
    },
  });
  return toArray(response.data?.Items);
}

export async function getItem(userId: string, itemId: string): Promise<JellyfinItem> {
  const response = await apiClient.get<JellyfinItem>(`/proxy/Items/${itemId}`, {
    params: { userId },
  });
  return response.data;
}

/**
 * Fetches the audio tracks directly under a parent item (album or playlist),
 * sorted by track number.
 */
async function getChildTracks(userId: string, parentId: string): Promise<Track[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Items', {
    params: {
      userId,
      ParentId: parentId,
      IncludeItemTypes: 'Audio',
      SortBy: 'IndexNumber',
      SortOrder: 'Ascending',
      // PlaylistItemId is returned on playlist children — needed to remove
      // specific song rows from a playlist later.
      Fields: 'IndexNumber,SortName,PlaylistItemId',
    },
  });
  return toArray<Track>(response.data?.Items);
}

// --- Playback reporting ---
//
// Uses the modern ReportPlayback* endpoints (POST body). The legacy
// OnPlayback* query-param endpoints are deprecated and hidden from the
// Jellyfin 12 spec. Reporting drives play counts, recently-played ordering,
// resume state, and the dashboard "Now Playing" indicator.
//
// All helpers are fire-and-forget safe: failures resolve silently so a
// reporting hiccup can never interrupt audio playback.

export type JellyfinRepeatMode = 'RepeatNone' | 'RepeatAll' | 'RepeatOne';

export interface PlaybackReportInfo {
  itemId: string;
  playSessionId: string;
  positionTicks?: number;
  isPaused?: boolean;
  isMuted?: boolean;
  volumeLevel?: number;
  repeatMode?: JellyfinRepeatMode;
}

/** Converts player seconds to Jellyfin ticks (10^7 per second). */
export function secondsToTicks(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.floor(seconds * 10_000_000);
}

/** Maps the player store repeat mode to the Jellyfin enum. */
export function toJellyfinRepeatMode(mode: string): JellyfinRepeatMode {
  if (mode === 'all') return 'RepeatAll';
  if (mode === 'one') return 'RepeatOne';
  return 'RepeatNone';
}

async function postPlaybackReport(path: string, body: Record<string, unknown>): Promise<void> {
  try {
    await apiClient.post(`/proxy${path}`, body);
  } catch {
    // Reporting must never break playback — swallow errors silently.
    // (Auth failures still surface via the shared 401 interceptor.)
  }
}

function playbackBody(info: PlaybackReportInfo): Record<string, unknown> {
  return {
    ItemId: info.itemId,
    MediaSourceId: info.itemId,
    PlaySessionId: info.playSessionId,
    // Universal audio may direct-play or transcode server-side; the server
    // downgrades a phantom Transcode claim automatically, so DirectPlay is
    // the honest client-side default.
    PlayMethod: 'DirectPlay',
    CanSeek: true,
    ...(info.positionTicks !== undefined ? { PositionTicks: info.positionTicks } : {}),
    ...(info.isPaused !== undefined ? { IsPaused: info.isPaused } : {}),
    ...(info.isMuted !== undefined ? { IsMuted: info.isMuted } : {}),
    ...(info.volumeLevel !== undefined ? { VolumeLevel: info.volumeLevel } : {}),
    ...(info.repeatMode ? { RepeatMode: info.repeatMode } : {}),
  };
}

export function reportPlaybackStart(info: PlaybackReportInfo): Promise<void> {
  return postPlaybackReport('/Sessions/Playing', playbackBody(info));
}

export function reportPlaybackProgress(info: PlaybackReportInfo): Promise<void> {
  return postPlaybackReport('/Sessions/Playing/Progress', playbackBody(info));
}

export function reportPlaybackStopped(
  info: Pick<PlaybackReportInfo, 'itemId' | 'playSessionId' | 'positionTicks'>
): Promise<void> {
  return postPlaybackReport('/Sessions/Playing/Stopped', {
    ItemId: info.itemId,
    MediaSourceId: info.itemId,
    PlaySessionId: info.playSessionId,
    ...(info.positionTicks !== undefined ? { PositionTicks: info.positionTicks } : {}),
  });
}

// --- Media URL builders ---

// Pipe-separated container|codec pairs. Opus is served natively (webm|opus, ogg)
// so it plays directly without transcoding. Other formats are listed as fallbacks.
const AUDIO_CONTAINERS = encodeURIComponent(
  'opus,webm|opus,mp3,aac,m4a|aac,flac,webma,webm|webma,wav,ogg'
);

/**
 * Builds the audio stream URL. Auth is handled by the server-side session
 * cookie — the Jellyfin token is never exposed in the URL.
 */
export function buildAudioUrl(trackId: string): string {
  const { userId, deviceId } = useAuthStore.getState();
  return (
    withBase(`/api/proxy/Audio/${trackId}/universal`) +
    `?UserId=${encodeURIComponent(userId)}` +
    `&DeviceId=${encodeURIComponent(deviceId)}` +
    `&MaxStreamingBitrate=140000000` +
    `&Container=${AUDIO_CONTAINERS}` +
    // Pin the transcode output: <audio> can't play HLS, so a future Jellyfin
    // default flip to hls would silently kill every transcoded format.
    `&TranscodingProtocol=http` +
    `&TranscodingContainer=aac`
  );
}

/**
 * Builds an image URL. Auth is handled by the server-side session cookie —
 * the Jellyfin token is never exposed in the URL.
 */
export function buildImageUrl(
  itemId: string,
  maxWidth: number = 300,
  imageType: 'Primary' | 'Thumb' = 'Primary'
): string {
  return (
    withBase(`/api/proxy/Items/${itemId}/Images/${imageType}`) +
    `?maxWidth=${maxWidth}` +
    `&quality=90`
  );
}

/**
 * Builds the best available image URL for a track, in priority order:
 * 1. The track's own embedded Primary thumbnail
 * 2. The track's Thumb image
 * 3. The album art
 * 4. null (caller falls back to a placeholder icon)
 */
export function buildTrackImageUrl(track: Track, maxWidth: number = 300): string | null {
  if (track.ImageTags?.Primary) {
    return buildImageUrl(track.Id, maxWidth, 'Primary');
  }
  if (track.ImageTags?.Thumb) {
    return buildImageUrl(track.Id, maxWidth, 'Thumb');
  }
  if (track.AlbumId) {
    return buildImageUrl(track.AlbumId, maxWidth, 'Primary');
  }
  return null;
}
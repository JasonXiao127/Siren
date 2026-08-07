import { apiClient } from './client';
import { useAuthStore } from '@/store/authStore';
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
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Users/' + userId + '/Items', {
    params: {
      IncludeItemTypes: 'Playlist',
      // Without Recursive, Jellyfin ignores IncludeItemTypes on this endpoint
      // and returns top-level library folders (Movies, TV Shows, Music, ...)
      // instead of actual playlists.
      Recursive: true,
      Limit: 100,
    },
  });
  return response.data.Items || [];
}

export async function getPlaylistTracks(userId: string, playlistId: string): Promise<Track[]> {
  return getChildTracks(userId, playlistId);
}

export async function getRecentlyAdded(userId: string): Promise<Track[]> {
  const response = await apiClient.get<JellyfinItem[]>('/proxy/Users/' + userId + '/Items/Latest', {
    params: {
      IncludeItemTypes: 'Audio',
      Limit: 24,
      Fields: 'PrimaryImageAspectRatio,DateCreated',
    },
  });
  return (response.data || []) as Track[];
}

export async function getAlbums(userId: string): Promise<JellyfinItem[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Users/' + userId + '/Items', {
    params: {
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Limit: 200,
    },
  });
  return response.data.Items || [];
}

export async function getFavorites(userId: string): Promise<Track[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Users/' + userId + '/Items', {
    params: {
      Filters: 'IsFavorite',
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Limit: 200,
    },
  });
  return (response.data.Items || []) as Track[];
}

export async function setFavorite(
  userId: string,
  itemId: string,
  isFavorite: boolean
): Promise<void> {
  if (isFavorite) {
    await apiClient.post(`/proxy/Users/${userId}/FavoriteItems/${itemId}`);
  } else {
    await apiClient.delete(`/proxy/Users/${userId}/FavoriteItems/${itemId}`);
  }
}

export async function getRecentlyPlayed(userId: string): Promise<Track[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Users/' + userId + '/Items', {
    params: {
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
      Limit: 24,
      Fields: 'PrimaryImageAspectRatio',
    },
  });
  return (response.data.Items || []) as Track[];
}

export async function getFrequentlyPlayed(userId: string): Promise<Track[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Users/' + userId + '/Items', {
    params: {
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'PlayCount',
      SortOrder: 'Descending',
      Limit: 24,
      Fields: 'PrimaryImageAspectRatio',
    },
  });
  return (response.data.Items || []) as Track[];
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
  const response = await apiClient.get<JellyfinArtistsResponse>('/proxy/Artists', {
    params: {
      UserId: userId,
      Limit: 200,
    },
  });
  return response.data.Items || [];
}

export async function searchMusic(userId: string, query: string): Promise<JellyfinItem[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Users/' + userId + '/Items', {
    params: {
      searchTerm: query,
      IncludeItemTypes: 'Audio,MusicAlbum',
      Recursive: true,
      Limit: 50,
    },
  });
  return response.data.Items || [];
}

export async function getAlbumTracks(userId: string, albumId: string): Promise<Track[]> {
  return getChildTracks(userId, albumId);
}

export async function getArtistAlbums(userId: string, artistId: string): Promise<JellyfinItem[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Users/' + userId + '/Items', {
    params: {
      ArtistIds: artistId,
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      SortBy: 'ProductionYear',
      SortOrder: 'Ascending',
    },
  });
  return response.data.Items || [];
}

export async function getItem(userId: string, itemId: string): Promise<JellyfinItem> {
  const response = await apiClient.get<JellyfinItem>(`/proxy/Users/${userId}/Items/${itemId}`);
  return response.data;
}

/**
 * Fetches the audio tracks directly under a parent item (album or playlist),
 * sorted by track number.
 */
async function getChildTracks(userId: string, parentId: string): Promise<Track[]> {
  const response = await apiClient.get<JellyfinItemsResponse>('/proxy/Users/' + userId + '/Items', {
    params: {
      ParentId: parentId,
      IncludeItemTypes: 'Audio',
      SortBy: 'IndexNumber',
      SortOrder: 'Ascending',
      // PlaylistItemId is returned on playlist children — needed to remove
      // specific song rows from a playlist later.
      Fields: 'IndexNumber,SortName,PlaylistItemId',
    },
  });
  return (response.data.Items || []) as Track[];
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
    `/api/proxy/Audio/${trackId}/universal` +
    `?UserId=${encodeURIComponent(userId)}` +
    `&DeviceId=${encodeURIComponent(deviceId)}` +
    `&MaxStreamingBitrate=140000000` +
    `&Container=${AUDIO_CONTAINERS}`
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
    `/api/proxy/Items/${itemId}/Images/${imageType}` +
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
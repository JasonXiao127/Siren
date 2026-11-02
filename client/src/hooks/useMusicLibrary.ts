import { useQuery } from '@tanstack/react-query';
import { getUserViews, selectMusicLibraryId } from '@/api/jellyfin';

/**
 * Resolves the single music library id to scope /Items queries to, or null
 * when there is none / several (callers fall back to unscoped). Cached
 * aggressively: UserViews itself walks the playlist-visibility path, so it
 * must not refetch on every navigation.
 */
export function useMusicLibraryId(userId: string): {
  musicLibraryId: string | null;
  viewsReady: boolean;
} {
  const { data: views, isError: viewsError } = useQuery({
    queryKey: ['user-views', userId],
    queryFn: () => getUserViews(userId),
    enabled: !!userId,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  return {
    musicLibraryId: selectMusicLibraryId(views),
    // If UserViews itself fails, fall back to unscoped rather than hanging
    // every music section on skeletons forever.
    viewsReady: views !== undefined || viewsError,
  };
}

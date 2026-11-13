import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { useState, useEffect } from 'react';
import { apiClient } from '@/api/client';
import { restoreSession } from '@/api/jellyfin';
import TopBar from '@/components/layout/TopBar';
import Sidebar from '@/components/layout/Sidebar';
import MainContent from '@/components/layout/MainContent';
import RightSidebar from '@/components/layout/RightSidebar';
import PlayerBar from '@/components/layout/PlayerBar';
import ExpandedPlayer from '@/components/player/ExpandedPlayer';
import Login from '@/pages/Login';
import Home from '@/pages/Home';
import PlaylistView from '@/pages/PlaylistView';
import AlbumView from '@/pages/AlbumView';
import ArtistView from '@/pages/ArtistView';
import Search from '@/pages/Search';
import Albums from '@/pages/Albums';
import Favorites from '@/pages/Favorites';

function ProtectedLayout() {
  const user = useAuthStore((state) => state.user);
  const userId = useAuthStore((state) => state.userId);
  const serverUrl = useAuthStore((state) => state.serverUrl);
  const restoreToken = useAuthStore((state) => state.restoreToken);
  const login = useAuthStore((state) => state.login);
  const logout = useAuthStore((state) => state.logout);
  const location = useLocation();
  const [queueOpen, setQueueOpen] = useState(false);
  const [playerExpanded, setPlayerExpanded] = useState(false);
  const [validating, setValidating] = useState(true);

  // Validate the httpOnly server session on boot. LocalStorage alone would
  // paint the authed shell with a dead cookie (flash + 401 storm). When the
  // cookie is gone but the device restore token survived (browsers that clear
  // cookies on exit), trade the token for a fresh cookie instead of bouncing
  // to the login screen. On success sync the server's user/serverUrl into the
  // store: a stale persisted userId (e.g. after a server-side user recreate)
  // would otherwise make every proxied Jellyfin call use the wrong id and
  // fail as "empty library".
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setValidating(false);
      return;
    }

    const syncFromSession = (
      sessionUser: { id: string; name: string } | undefined,
      sessionServerUrl: string | undefined
    ) => {
      if (
        !cancelled &&
        sessionUser &&
        typeof sessionUser.id === 'string' &&
        sessionServerUrl &&
        (sessionUser.id !== userId ||
          sessionUser.name !== user?.name ||
          sessionServerUrl !== serverUrl)
      ) {
        login(sessionServerUrl, sessionUser.id, sessionUser, restoreToken);
      }
    };

    // Only a 401 means "this browser has no valid session". A network error or
    // 5xx (container restarting, proxy hiccup) must keep the saved login so the
    // next attempt can restore instead of wiping it.
    const isUnauthorized = (err: unknown) =>
      (err as { response?: { status?: number } })?.response?.status === 401;

    void (async () => {
      try {
        const res = await apiClient.get('/auth/session');
        syncFromSession(res.data?.user, res.data?.serverUrl);
      } catch (error) {
        if (!isUnauthorized(error)) return;
        if (restoreToken) {
          try {
            const restored = await restoreSession(restoreToken);
            if (!cancelled && restored?.user && restored.serverUrl) {
              // Only write state when something actually changed. Re-setting
              // an identical user object would re-run this effect forever if
              // the browser also rejects the freshly issued cookie.
              if (
                restored.user.id !== userId ||
                restored.user.name !== user?.name ||
                restored.serverUrl !== serverUrl
              ) {
                login(
                  restored.serverUrl,
                  restored.user.id,
                  restored.user,
                  restoreToken
                );
              }
              return;
            }
          } catch (restoreError) {
            if (!isUnauthorized(restoreError)) return;
            // Invalid/expired token — require a normal login.
          }
        }
        if (!cancelled) logout();
      } finally {
        if (!cancelled) setValidating(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, userId, serverUrl, restoreToken, login, logout]);

  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (validating) {
    return <div className="flex h-screen w-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex h-screen w-screen flex-col">
      {/* Top bar — doubles as the window drag region (hidden title bar).
          Interactive children opt out via .app-no-drag inside TopBar.
          Drag is disabled while the expanded player overlays it: Chromium
          drag regions are not occlusion-aware, so leaving it active would
          swallow real clicks on the overlay's controls. */}
      <div
        className={`titlebar-safe h-[60px] shrink-0 border-b border-border ${
          playerExpanded ? '' : 'app-drag'
        }`}
      >
        <TopBar />
      </div>

      {/* Middle: sidebar + main + queue */}
      <div className="flex min-h-0 flex-1">
        <div className="w-[280px] shrink-0 overflow-y-auto border-r border-border">
          <Sidebar />
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <MainContent />
        </div>

        <div
          className={`shrink-0 border-l border-border transition-[width] duration-200 ${
            queueOpen && !playerExpanded
              ? 'w-[320px]'
              : 'pointer-events-none invisible w-0 overflow-hidden'
          }`}
        >
          <RightSidebar open={queueOpen && !playerExpanded} />
        </div>
      </div>

      {/* Player bar — always visible */}
      <div className="h-[90px] shrink-0 border-t border-border">
        <PlayerBar
          onToggleQueue={() => setQueueOpen((v) => !v)}
          queueOpen={queueOpen}
          onExpand={() => {
            setQueueOpen(false);
            setPlayerExpanded(true);
          }}
        />
      </div>

      {/* Expanded player overlay */}
      <ExpandedPlayer open={playerExpanded} onClose={() => setPlayerExpanded(false)} />
    </div>
  );
}

function WildcardRedirect({ user }: { user: unknown }) {
  const location = useLocation();
  if (user) return <Navigate to="/" replace />;
  const next = encodeURIComponent(location.pathname + location.search);
  return <Navigate to={`/login?next=${next}`} replace />;
}

export default function App() {
  const user = useAuthStore((state) => state.user);
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/albums" element={<Albums />} />
        <Route path="/favorites" element={<Favorites />} />
        <Route path="/playlist/:id" element={<PlaylistView />} />
        <Route path="/album/:id" element={<AlbumView />} />
        <Route path="/artist/:id" element={<ArtistView />} />
        <Route path="/search" element={<Search />} />
      </Route>
      <Route path="*" element={<WildcardRedirect user={user} />} />
    </Routes>
  );
}
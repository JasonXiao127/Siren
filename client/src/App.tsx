import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { useState, useEffect } from 'react';
import { apiClient } from '@/api/client';
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
  const logout = useAuthStore((state) => state.logout);
  const location = useLocation();
  const [queueOpen, setQueueOpen] = useState(false);
  const [playerExpanded, setPlayerExpanded] = useState(false);
  const [validating, setValidating] = useState(true);

  // Validate the httpOnly server session on boot. LocalStorage alone would
  // paint the authed shell with a dead cookie (flash + 401 storm).
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setValidating(false);
      return;
    }
    apiClient
      .get('/auth/session')
      .catch(() => {
        logout();
      })
      .finally(() => {
        if (!cancelled) setValidating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, logout]);

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
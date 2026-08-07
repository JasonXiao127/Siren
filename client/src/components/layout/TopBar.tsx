import { useState, FormEvent, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, LogOut, User } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuthStore } from '@/store/authStore';
import { logout as apiLogout } from '@/api/jellyfin';

export default function TopBar() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const [searchTerm, setSearchTerm] = useState('');

  // Sync the search input with the URL query param when navigating
  useEffect(() => {
    setSearchTerm(searchParams.get('q') || '');
  }, [searchParams]);

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    const term = searchTerm.trim();
    if (term) {
      navigate(`/search?q=${encodeURIComponent(term)}`);
    }
  }

  async function handleLogout() {
    // Clear the server-side session cookie, then local state
    await apiLogout();
    logout();
    navigate('/login');
  }

  return (
    <div className="flex h-full items-center justify-between px-4">
      {/* Logo */}
      <div className="flex items-center gap-2">
        <img src="/siren.svg" alt="Siren" className="h-8 w-8" />
        <span className="text-lg font-bold">Siren</span>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="relative w-96">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search songs, albums, artists…"
          className="pl-9"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </form>

      {/* User menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-2">
            <User className="h-4 w-4" />
            <span>{user?.name || 'User'}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel>{user?.name || 'User'}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void handleLogout()}>
            <LogOut className="h-4 w-4" />
            Logout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
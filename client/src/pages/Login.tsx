import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/store/authStore';
import { login as apiLogin } from '@/api/jellyfin';

function isValidServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function Login() {
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const deviceId = useAuthStore((state) => state.deviceId);

  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);

    if (!isValidServerUrl(serverUrl)) {
      toast.error('Please enter a valid server URL (http:// or https://)');
      setLoading(false);
      return;
    }

    try {
      const result = await apiLogin(serverUrl, username, password, deviceId);
      login(result.serverUrl, result.user.id, result.user);
      navigate('/');
    } catch (error) {
      const message =
        (error as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'Login failed. Please try again.';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4 py-8">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center gap-2">
          <img src="/siren.svg" alt="Siren" className="h-16 w-16" />
          <h1 className="text-3xl font-bold">Siren</h1>
          <p className="text-sm text-muted-foreground">
            Connect to your Jellyfin server
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="serverUrl" className="text-sm font-medium">
              Server URL
            </label>
            <Input
              id="serverUrl"
              type="url"
              placeholder="http://192.168.1.100:8096"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="username" className="text-sm font-medium">
              Username
            </label>
            <Input
              id="username"
              type="text"
              placeholder="jellyfin_username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Connecting…' : 'Sign In'}
          </Button>
        </form>
      </div>
    </div>
  );
}
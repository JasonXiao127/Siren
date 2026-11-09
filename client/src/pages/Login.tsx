import { useState, FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/store/authStore';
import { login as apiLogin } from '@/api/jellyfin';
import { withBase } from '@/lib/base';

type Protocol = 'http' | 'https';

function isValidServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Builds the Jellyfin URL from the split form fields. The host field also
 * accepts a pasted full URL; its scheme and an explicit port are honored so
 * old bookmarks can still be pasted in.
 */
function resolveServerUrl(protocol: Protocol, rawHost: string, rawPort: string): string {
  let value = rawHost.trim();
  let scheme = protocol;
  const schemeMatch = value.match(/^(https?):\/\//i);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase() as Protocol;
    value = value.slice(schemeMatch[0].length);
  }

  // Keep any Jellyfin base path (e.g. /jellyfin) after the authority.
  const slash = value.indexOf('/');
  let authority = slash === -1 ? value : value.slice(0, slash);
  const path = slash === -1 ? '' : value.slice(slash);

  const hasPort =
    /^\[[^\]]+\]:\d+$/.test(authority) ||
    (!authority.startsWith('[') && /:\d+$/.test(authority));
  if (!hasPort && rawPort.trim()) {
    authority = `${authority}:${rawPort.trim()}`;
  }

  return `${scheme}://${authority}${path}`.replace(/\/+$/, '');
}

// Mirrors the server's minimal URL guard so blocked targets get a clear
// message here instead of a generic "Invalid server URL" from the API.
function isBlockedServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    const rawHost = url.hostname.toLowerCase();
    const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
    if (/^(169\.254\.|0\.)/.test(host)) return true;
    if (host === '0' || host === '0.0.0.0') return true;
    return /^(fe[89ab][0-9a-f]*:)/.test(host);
  } catch {
    return false;
  }
}

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const login = useAuthStore((state) => state.login);
  const deviceId = useAuthStore((state) => state.deviceId);

  const [protocol, setProtocol] = useState<Protocol>('http');
  const [serverHost, setServerHost] = useState('');
  const [serverPort, setServerPort] = useState('8096');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  function handleHostChange(value: string) {
    setServerHost(value);
    // Keep the protocol selector in sync when someone pastes a full URL.
    const scheme = value.match(/^(https?):\/\//i);
    if (scheme) setProtocol(scheme[1].toLowerCase() as Protocol);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);

    if (!serverHost.trim()) {
      toast.error('Enter your Jellyfin server IP or hostname');
      setLoading(false);
      return;
    }

    const portValue = serverPort.trim();
    if (portValue) {
      const port = Number(portValue);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        toast.error('Enter a valid port (1–65535)');
        setLoading(false);
        return;
      }
    }

    const serverUrl = resolveServerUrl(protocol, serverHost, portValue);

    if (!isValidServerUrl(serverUrl)) {
      toast.error('Please enter a valid server address');
      setLoading(false);
      return;
    }

    if (isBlockedServerUrl(serverUrl)) {
      toast.error("That address can't be used — use the LAN IP/hostname, without credentials");
      setLoading(false);
      return;
    }

    // Autofill can populate the DOM without firing React's onChange, leaving
    // state empty even though the native `required` check passed.
    if (!username.trim() || !password) {
      toast.error('Enter your username and password');
      setLoading(false);
      return;
    }

    try {
      const result = await apiLogin(serverUrl, username, password, deviceId);
      login(result.serverUrl, result.user.id, result.user);
      const next = searchParams.get('next');
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
    } catch (error) {
      const response = (
        error as {
          response?: { status?: number; data?: { error?: string; code?: string } };
        }
      )?.response;
      const message = response?.data?.error || 'Login failed. Please try again.';
      // Keep the toast human-readable; log the stable code (and status) so bug
      // reports can identify the exact failure path without guessing.
      console.error('[siren] Login failed:', {
        code: response?.data?.code,
        status: response?.status,
      });
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center bg-background p-4 py-8">
      {/* Window drag region (hidden title bar) */}
      <div className="app-drag absolute inset-x-0 top-0 z-40 h-9" />
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center gap-2">
          <img src={withBase('/siren.svg')} alt="Siren" className="h-16 w-16" />
          <h1 className="text-3xl font-bold">Siren</h1>
          <p className="text-sm text-muted-foreground">
            Connect to your Jellyfin server
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="serverHost" className="text-sm font-medium">
              Jellyfin server
            </label>
            <div className="flex gap-2">
              <select
                aria-label="Protocol"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as Protocol)}
                className="h-9 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="http">http://</option>
                <option value="https">https://</option>
              </select>
              <Input
                id="serverHost"
                type="text"
                placeholder="192.168.1.100"
                value={serverHost}
                onChange={(e) => handleHostChange(e.target.value)}
                required
                autoFocus
                className="min-w-0 flex-1"
              />
              <Input
                id="serverPort"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                placeholder="8096"
                aria-label="Port"
                value={serverPort}
                onChange={(e) => setServerPort(e.target.value)}
                required
                className="w-24 text-center"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Port defaults to 8096. Choose https:// if your Jellyfin uses TLS.
            </p>
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
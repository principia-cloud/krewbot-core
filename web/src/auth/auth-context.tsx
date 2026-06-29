import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import {
  getToken,
  decodeToken,
  isTokenExpired,
  refreshToken,
  logout as cognitoLogout,
  type TokenClaims,
} from './cognito';

interface AuthState {
  user: TokenClaims | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  logout: () => void;
  /** Force-refresh the token and update user state. */
  ensureToken: () => Promise<string | null>;
  /** Re-read token from localStorage and update state (call after login). */
  recheck: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<TokenClaims | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // On mount, check for existing valid token
  useEffect(() => {
    const token = getToken();
    if (!token) {
      setIsLoading(false);
      return;
    }

    if (isTokenExpired(token)) {
      // Try refreshing
      refreshToken().then((ok) => {
        if (ok) {
          const newToken = getToken();
          if (newToken) setUser(decodeToken(newToken));
        }
        setIsLoading(false);
      });
    } else {
      setUser(decodeToken(token));
      setIsLoading(false);
    }
  }, []);

  const ensureToken = useCallback(async (): Promise<string | null> => {
    const token = getToken();
    if (!token) return null;

    if (!isTokenExpired(token)) return token;

    const ok = await refreshToken();
    if (!ok) {
      setUser(null);
      return null;
    }
    const newToken = getToken();
    if (newToken) setUser(decodeToken(newToken));
    return newToken;
  }, []);

  const recheck = useCallback(() => {
    const token = getToken();
    if (token && !isTokenExpired(token)) {
      setUser(decodeToken(token));
    }
  }, []);

  const logout = useCallback(() => {
    // Sweep any stashed onboarding drafts before signing out, so a later
    // user on the same browser can't peek at a previous user's wizard input
    // via dev tools. Keys are prefixed `platform:onboarding:draft:{sub}` by
    // the onboarding page; kept in sync with that constant.
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith('platform:onboarding:draft:')) {
          sessionStorage.removeItem(key);
        }
      }
    } catch {
      // sessionStorage unavailable (private mode) — safe to skip.
    }
    setUser(null);
    cognitoLogout();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        logout,
        ensureToken,
        recheck,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

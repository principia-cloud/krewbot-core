import { API_URL } from '@/lib/constants';
import { getToken, isTokenExpired, refreshToken, clearTokens } from '@/auth/cognito';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getValidToken(): Promise<string> {
  let token = getToken();
  if (!token) throw new ApiError(401, 'Not authenticated');

  if (isTokenExpired(token)) {
    const ok = await refreshToken();
    if (!ok) {
      clearTokens();
      throw new ApiError(401, 'Session expired');
    }
    token = getToken();
    if (!token) throw new ApiError(401, 'Session expired');
  }

  return token;
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const token = await getValidToken();

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  });

  if (res.status === 401) {
    // Try refresh once
    const ok = await refreshToken();
    if (ok) {
      const newToken = getToken();
      if (newToken) {
        const retry = await fetch(`${API_URL}${path}`, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${newToken}`,
            ...options?.headers,
          },
        });
        if (retry.ok) {
          if (retry.status === 204) return undefined as T;
          return retry.json();
        }
      }
    }
    clearTokens();
    throw new ApiError(401, 'Session expired');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || body.message || `Request failed: ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

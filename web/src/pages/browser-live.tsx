/**
 * Browser live-view page — renders an AgentCore browser session
 * as a live, interactive DCV stream.
 *
 * The agent sends the user a link like:
 *   https://<app-url>/browser-live?url=<base64-encoded-presigned-url>
 *
 * This page decodes the presigned URL and passes it to the
 * BrowserLiveView component from the bedrock-agentcore SDK, which
 * handles DCV protocol negotiation, video decoding, and mouse/keyboard
 * input marshaling.
 *
 * No auth required on this page — the presigned URL IS the auth
 * (SigV4 in query params, 5-min TTL). The page is public so the user
 * can open it from the chat link without logging into the console.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

export function BrowserLivePage() {
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [LiveView, setLiveView] = useState<React.ComponentType<{
    signedUrl: string;
    remoteWidth?: number;
    remoteHeight?: number;
  }> | null>(null);

  // Decode the presigned URL from the query param
  const signedUrl = useMemo(() => {
    const encoded = searchParams.get('url');
    if (!encoded) return null;
    try {
      return atob(encoded);
    } catch {
      // If not base64, try using it directly (in case it was passed raw)
      return encoded;
    }
  }, [searchParams]);

  // Dynamically import BrowserLiveView (heavy dependency — don't
  // bundle it into the main app chunk)
  useEffect(() => {
    if (!signedUrl) {
      setError('No live-view URL provided. This link may have expired — ask the agent for a new one.');
      setLoading(false);
      return;
    }

    import('bedrock-agentcore/browser/live-view')
      .then((mod) => {
        setLiveView(() => mod.BrowserLiveView);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load BrowserLiveView:', err);
        setError(
          'Failed to load the browser viewer. Please refresh the page and try again.'
        );
        setLoading(false);
      });
  }, [signedUrl]);

  if (error) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', fontFamily: 'system-ui, sans-serif',
        flexDirection: 'column', gap: '16px', padding: '24px',
        textAlign: 'center', color: '#475569',
      }}>
        <div style={{ fontSize: '48px' }}>🌐</div>
        <h1 style={{ fontSize: '20px', fontWeight: 600, color: '#0f172a', margin: 0 }}>
          Browser Session
        </h1>
        <p style={{ maxWidth: '400px', lineHeight: 1.6 }}>{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', fontFamily: 'system-ui, sans-serif',
        flexDirection: 'column', gap: '12px', color: '#475569',
      }}>
        <div style={{ fontSize: '32px', animation: 'spin 1s linear infinite' }}>⏳</div>
        <p>Connecting to browser session...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    );
  }

  if (!LiveView || !signedUrl) return null;

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#dee1e6', overflow: 'hidden' }}>
      <div style={{
        width: '100vw',
        height: 'max(100vh, calc(100vw * 1080 / 1920))',
        position: 'relative',
      }}>
        <LiveView
          signedUrl={signedUrl}
          remoteWidth={1920}
          remoteHeight={1080}
        />
      </div>
    </div>
  );
}

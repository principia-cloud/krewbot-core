"""Unit tests for the Microsoft 365 OAuth seam in workspace-api.

Covers:
- INTEGRATIONS["microsoft"] registry entry shape.
- MS_GRAPH_SCOPES contains offline_access (required for refresh_token).
- _exchange_microsoft_token happy path: token POST + id_token tenant
  extraction + assembled blob.
- _exchange_microsoft_token returns None when the token response omits
  refresh_token (Azure does this if the app isn't registered for
  offline_access, which would silently break the agent).
- microsoft_auth_url route assembles a consent URL with prompt=consent,
  response_mode=query, all scopes joined by spaces, and the workspace
  ID round-tripped through `state`.

Uses the shared loader from test_workspace_api_neutral so the import
shape stays consistent across the test suite.
"""

from __future__ import annotations

import base64
import json
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlparse

import pytest

from test_workspace_api_neutral import _load_workspace_api


@pytest.fixture
def wsapi(monkeypatch):
    return _load_workspace_api(monkeypatch)


def _b64url_no_padding(payload: dict) -> str:
    raw = json.dumps(payload).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _make_id_token(claims: dict) -> str:
    """Build a fake JWT with the given claims as the body. Signature is
    a dummy — _exchange_microsoft_token only decodes the body."""
    header = _b64url_no_padding({"alg": "none"})
    body = _b64url_no_padding(claims)
    return f"{header}.{body}.signature"


# ---------------------------------------------------------------------------
# Registry + scope shape
# ---------------------------------------------------------------------------


def test_microsoft_in_integrations_registry(wsapi):
    spec = wsapi.INTEGRATIONS.get("microsoft")
    assert spec is not None
    assert spec["body_key"] == "credentials"
    assert spec["secret_name"] == "microsoft-account-token"


def test_offline_access_in_scopes(wsapi):
    # Without offline_access in the consent request, Azure returns an
    # access_token only — no refresh_token — and the agent's refresh
    # shim has nothing to work with. Pin this so a future trim doesn't
    # silently strip it.
    assert "offline_access" in wsapi.MS_GRAPH_SCOPES


def test_scopes_include_write_capable_surfaces(wsapi):
    # Catch a regression if someone drops back to read-only by mistake.
    for required in (
        "Mail.Send",
        "Mail.ReadWrite",
        "Calendars.ReadWrite",
        "Files.ReadWrite.All",
    ):
        assert required in wsapi.MS_GRAPH_SCOPES


# ---------------------------------------------------------------------------
# _exchange_microsoft_token
# ---------------------------------------------------------------------------


def _stub_secret(wsapi, payload: dict):
    """Stub secrets_client.get_secret_value to return the given JSON
    payload as the Microsoft OAuth platform secret."""
    wsapi.secrets_client.get_secret_value = MagicMock(
        return_value={"SecretString": json.dumps(payload)}
    )


def test_exchange_returns_blob_with_tenant_from_id_token(wsapi):
    _stub_secret(wsapi, {"client_id": "app-id", "client_secret": "app-secret"})

    id_token = _make_id_token({"tid": "tenant-guid-123", "upn": "alice@example.com"})
    token_response = {
        "access_token": "at_value",
        "refresh_token": "rt_value",
        "id_token": id_token,
    }

    def fake_urlopen(req, *a, **kw):
        ctx = MagicMock()
        ctx.__enter__ = MagicMock(return_value=MagicMock(read=lambda: json.dumps(token_response).encode()))
        ctx.__exit__ = MagicMock(return_value=False)
        # /me lookup — return UPN.
        if "graph.microsoft.com" in req.full_url:
            ctx.__enter__ = MagicMock(
                return_value=MagicMock(
                    read=lambda: json.dumps({"userPrincipalName": "alice@example.com"}).encode()
                )
            )
        return ctx

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        # Localhost URIs are always on the H5 allowlist regardless of
        # APP_URL (loopback is unreachable by an attacker), so we use one
        # here to keep the test self-contained.
        result = wsapi._exchange_microsoft_token(
            {"auth_code": "code_xyz", "redirect_uri": "http://localhost:5173/oauth/microsoft/callback"}
        )

    assert result is not None
    assert result["client_id"] == "app-id"
    assert result["client_secret"] == "app-secret"
    assert result["refresh_token"] == "rt_value"
    assert result["tenant_id"] == "tenant-guid-123"
    assert result["account_name"] == "alice"
    assert "added_at" in result


def test_exchange_rejects_disallowed_redirect_uri(wsapi):
    # Mirrors the Google H5 hardening: a non-loopback URI outside APP_URL
    # must be refused before the token endpoint is ever called.
    _stub_secret(wsapi, {"client_id": "app-id", "client_secret": "app-secret"})

    with patch("urllib.request.urlopen") as mock_open:
        result = wsapi._exchange_microsoft_token(
            {"auth_code": "code", "redirect_uri": "https://attacker.example.com/steal"}
        )

    assert result is None
    mock_open.assert_not_called()


def test_exchange_returns_none_when_no_refresh_token(wsapi):
    # If offline_access is missing from the app registration or the user
    # somehow consents without it, Azure returns access_token without
    # refresh_token. That's unrecoverable for an unattended agent.
    _stub_secret(wsapi, {"client_id": "app-id", "client_secret": "app-secret"})

    token_response = {"access_token": "at_value"}  # no refresh_token

    def fake_urlopen(req, *a, **kw):
        ctx = MagicMock()
        ctx.__enter__ = MagicMock(
            return_value=MagicMock(read=lambda: json.dumps(token_response).encode())
        )
        ctx.__exit__ = MagicMock(return_value=False)
        return ctx

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = wsapi._exchange_microsoft_token(
            {"auth_code": "code_xyz", "redirect_uri": "http://localhost:5173/oauth/microsoft/callback"}
        )

    assert result is None


def test_exchange_returns_none_when_payload_missing_fields(wsapi):
    assert wsapi._exchange_microsoft_token({}) is None
    assert wsapi._exchange_microsoft_token({"auth_code": "x"}) is None
    assert wsapi._exchange_microsoft_token({"redirect_uri": "x"}) is None


# ---------------------------------------------------------------------------
# microsoft_auth_url route
# ---------------------------------------------------------------------------


def test_microsoft_auth_url_assembles_consent_url(wsapi, monkeypatch):
    # Bypass _require_admin — exercised by membership tests elsewhere.
    monkeypatch.setattr(wsapi, "_require_admin", lambda workspaceId: None)

    _stub_secret(wsapi, {"client_id": "azure-client-id"})
    redirect_uri = "http://localhost:5173/oauth/microsoft/callback"
    wsapi.app.current_event.get_query_string_value = MagicMock(
        return_value=redirect_uri
    )

    result = wsapi.microsoft_auth_url("ws-123")

    assert "url" in result
    parsed = urlparse(result["url"])
    assert parsed.scheme == "https"
    assert parsed.netloc == "login.microsoftonline.com"
    # /common is the multitenant authority used by a multitenant app.
    assert parsed.path == "/common/oauth2/v2.0/authorize"

    params = parse_qs(parsed.query)
    assert params["client_id"] == ["azure-client-id"]
    assert params["redirect_uri"] == [redirect_uri]
    assert params["response_type"] == ["code"]
    assert params["response_mode"] == ["query"]
    # prompt=consent ensures we always get a refresh_token, even on
    # re-consent — Azure's default skips the consent screen on repeat
    # connects and silently omits the refresh_token in that case.
    assert params["prompt"] == ["consent"]
    assert params["state"] == ["ws-123"]
    assert "offline_access" in params["scope"][0]


def test_microsoft_auth_url_rejects_disallowed_redirect_uri(wsapi, monkeypatch):
    monkeypatch.setattr(wsapi, "_require_admin", lambda workspaceId: None)
    _stub_secret(wsapi, {"client_id": "azure-client-id"})
    wsapi.app.current_event.get_query_string_value = MagicMock(
        return_value="https://attacker.example.com/oauth/microsoft/callback"
    )

    # BadRequestError is the powertools type the loader stubs; comparing
    # by name keeps the assertion robust to the stub class identity.
    with pytest.raises(Exception) as exc_info:
        wsapi.microsoft_auth_url("ws-123")
    assert type(exc_info.value).__name__ == "BadRequestError"

"""Auth-routes addon — neutral core stub.

`index.py` calls `register(app)` at module-load to let an addon attach
public auth routes (e.g. magic-link sign-in). The neutral default
registers nothing — core operators provision users via an admin CLI
or upstream SSO. Operators who want self-serve sign-in overlay a real
implementation.
"""


def register(app) -> None:
    """Neutral default: no public auth routes."""
    return

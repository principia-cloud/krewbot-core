"""Billing-routes addon — neutral core stub.

`index.py` calls `register(app)` at module-load to let an addon attach
billing-related routes (or any other extension routes). The neutral
default registers nothing. Operators overlay a real implementation if
they want a paywall, Stripe checkout, customer portal, etc.
"""


def register(app) -> None:
    """Neutral default: no addon routes."""
    return

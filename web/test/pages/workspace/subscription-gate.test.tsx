import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

// SubscriptionGate is a slot. The core stub is a passthrough (children
// rendered unconditionally) since self-hosted deployments have no
// concept of subscription status. An overlay impl wraps
// in a Stripe paywall.
import { SubscriptionGate } from '@/extensions/subscription-gate';

describe('SubscriptionGate (core stub — passthrough)', () => {
  it('always renders children — no subscription gating', () => {
    render(
      <SubscriptionGate>
        <div data-testid="protected">workspace content</div>
      </SubscriptionGate>,
    );
    expect(screen.getByTestId('protected')).toBeInTheDocument();
  });
});

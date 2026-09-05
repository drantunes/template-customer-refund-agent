import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

const originalSource = process.env.SUPPORT_SOURCE;

afterEach(() => {
  if (originalSource === undefined) {
    delete process.env.SUPPORT_SOURCE;
  } else {
    process.env.SUPPORT_SOURCE = originalSource;
  }
});

describe('Zendesk WIP characterization', () => {
  it('selects Zendesk and verifies its signed payload before Phase 001 removes it', async () => {
    process.env.SUPPORT_SOURCE = 'zendesk';
    const { getActiveSupportAdapter } = await import('../../src/mastra/integrations/active-adapter');
    const { verifyZendeskWebhookSignature } = await import('../../src/mastra/integrations/zendesk-support');
    const rawBody = '{"ticket":{"id":42}}';
    const timestamp = '1725408000';
    const secret = 'synthetic-characterization-secret';
    const signature = createHmac('sha256', secret).update(`${timestamp}${rawBody}`).digest('base64');

    expect(getActiveSupportAdapter().source).toBe('zendesk');
    expect(verifyZendeskWebhookSignature({ rawBody, timestamp, signature, secret })).toBe(true);
    expect(verifyZendeskWebhookSignature({ rawBody: '{}', timestamp, signature, secret })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { supportCaseSchema } from '../../src/mastra/domain/support-case';

describe('support case schema', () => {
  it('rejects an invalid customer email at the domain boundary', () => {
    const result = supportCaseSchema.safeParse({
      id: 'case-1',
      externalId: 'external-1',
      source: 'mock-email',
      customer: { email: 'not-an-email' },
      subject: 'Help',
      messages: [],
      status: 'new',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });
});

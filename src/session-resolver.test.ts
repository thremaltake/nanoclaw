import { describe, it, expect } from 'vitest';
import { resolveSession, SessionContext } from './session-resolver.js';

describe('resolveSession', () => {
  it('resolves DM to folder-level session with priority 1', () => {
    const ctx: SessionContext = {
      folder: 'acme',
      chatType: 'dm',
      senderId: 'u1',
    };
    const result = resolveSession(ctx);
    expect(result.sessionKey).toBe('acme');
    expect(result.queueKey).toBe('acme');
    expect(result.priority).toBe(1);
  });

  it('resolves shared operations topic to folder-level session with priority 2', () => {
    const ctx: SessionContext = {
      folder: 'acme',
      chatType: 'operations',
      topicKey: 'general',
      topicSession: 'shared',
    };
    const result = resolveSession(ctx);
    expect(result.sessionKey).toBe('acme');
    expect(result.queueKey).toBe('acme');
    expect(result.priority).toBe(2);
  });

  it('resolves independent topic to topic-level session', () => {
    const ctx: SessionContext = {
      folder: 'acme',
      chatType: 'operations',
      topicKey: 'invoices',
      topicSession: 'independent',
    };
    const result = resolveSession(ctx);
    expect(result.sessionKey).toBe('acme:topic:invoices');
    expect(result.queueKey).toBe('acme:topic:invoices');
    expect(result.priority).toBe(2);
  });

  it('resolves lead topic to per-deal session', () => {
    const ctx: SessionContext = {
      folder: 'acme',
      chatType: 'leads',
      dealId: 'deal-42',
    };
    const result = resolveSession(ctx);
    expect(result.sessionKey).toBe('acme:lead:deal-42');
    expect(result.queueKey).toBe('acme:lead:deal-42');
    expect(result.priority).toBe(2);
  });

  it('resolves customer-facing to per-customer session', () => {
    const ctx: SessionContext = {
      folder: 'acme',
      chatType: 'customer',
      senderId: 'customer-99',
    };
    const result = resolveSession(ctx);
    expect(result.sessionKey).toBe('acme:customer:customer-99');
    expect(result.queueKey).toBe('acme:customer:customer-99');
    expect(result.priority).toBe(1);
  });

  it('assigns priority 3 to scheduled tasks', () => {
    const ctx: SessionContext = {
      folder: 'acme',
      chatType: 'operations',
      isScheduledTask: true,
    };
    const result = resolveSession(ctx);
    expect(result.sessionKey).toBe('acme');
    expect(result.queueKey).toBe('acme');
    expect(result.priority).toBe(3);
  });

  it('falls back to folder session for leads without dealId', () => {
    const ctx: SessionContext = {
      folder: 'acme',
      chatType: 'leads',
    };
    const result = resolveSession(ctx);
    expect(result.sessionKey).toBe('acme');
    expect(result.queueKey).toBe('acme');
    expect(result.priority).toBe(2);
  });
});

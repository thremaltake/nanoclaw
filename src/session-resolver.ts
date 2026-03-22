export interface SessionContext {
  folder: string;
  chatType: 'dm' | 'operations' | 'leads' | 'customer';
  topicKey?: string;
  topicSession?: 'shared' | 'independent';
  dealId?: string;
  senderId?: string;
  isScheduledTask?: boolean;
}

export interface ResolvedSession {
  sessionKey: string;
  queueKey: string;
  priority: number; // 1 = highest (DM), 2 = topic reply, 3 = scheduled task
}

export function resolveSession(ctx: SessionContext): ResolvedSession {
  // Scheduled tasks -> priority 3, folder-level session
  if (ctx.isScheduledTask) return { sessionKey: ctx.folder, queueKey: ctx.folder, priority: 3 };

  // Customer-facing -> per-customer, always independent
  if (ctx.chatType === 'customer') {
    const key = `${ctx.folder}:customer:${ctx.senderId}`;
    return { sessionKey: key, queueKey: key, priority: 1 };
  }

  // Lead topics -> per-deal, always independent
  if (ctx.chatType === 'leads' && ctx.dealId) {
    const key = `${ctx.folder}:lead:${ctx.dealId}`;
    return { sessionKey: key, queueKey: key, priority: 2 };
  }

  // Independent operations topics -> own session + queue
  if (ctx.chatType === 'operations' && ctx.topicSession === 'independent' && ctx.topicKey) {
    const key = `${ctx.folder}:topic:${ctx.topicKey}`;
    return { sessionKey: key, queueKey: key, priority: 2 };
  }

  // DM or shared operations topics -> folder-level session
  const priority = ctx.chatType === 'dm' ? 1 : 2;
  return { sessionKey: ctx.folder, queueKey: ctx.folder, priority };
}

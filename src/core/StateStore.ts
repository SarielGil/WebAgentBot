import { Redis } from 'ioredis';
import { ConversationState } from './ConversationManager.js';

export class StateStore {
  private redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  async save(chatId: string, state: ConversationState) {
    await this.redis.set(
      `session:${chatId}`,
      JSON.stringify(state),
      'EX', 
      60 * 60 * 24 * 7  // 7 days TTL
    );
  }

  async load(chatId: string): Promise<ConversationState | null> {
    const raw = await this.redis.get(`session:${chatId}`);
    return raw ? JSON.parse(raw) : null;
  }
}

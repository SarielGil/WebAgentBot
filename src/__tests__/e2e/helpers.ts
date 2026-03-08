// src/__tests__/e2e/helpers.ts
import { vi } from 'vitest';
import { MessageHandler } from '../../orchestrator/messageHandler.js';
import { WorkflowGuard } from '../../core/WorkflowGuard.js';

// Mock dependencies for testing
const mockConversations = {
  addMessage: vi.fn().mockResolvedValue(undefined),
  getOrCreate: vi.fn(),
  buildPromptHistory: vi.fn().mockResolvedValue([]),
  updateProjectState: vi.fn().mockResolvedValue(undefined),
  advancePhase: vi.fn().mockResolvedValue(undefined),
};

const mockRouter = {
  classify: vi.fn(),
  route: vi.fn(),
};

const mockAgents = {
  dispatch: vi.fn(),
};

const workflowGuard = new WorkflowGuard();
const handler = new MessageHandler(
  mockConversations as any,
  mockRouter as any,
  mockAgents as any,
  workflowGuard
);

/**
 * Sends a message through the system and returns the textual response
 */
export async function sendMessage(chatId: string, text: string): Promise<string> {
  return await handler.handle(chatId, text);
}

/**
 * Pre-seeds a conversation by completing the discovery phase
 */
export async function completedDiscovery(chatId: string) {
  await sendMessage(chatId, 'I want a website for my bakery called Sweet Dreams');
  await sendMessage(chatId, 'Based in Jerusalem, targeting families');
  await sendMessage(chatId, 'Warm, inviting, homemade feel');
}

// Exporting mocks to allow tests to configure behavior
export { mockConversations, mockRouter, mockAgents };

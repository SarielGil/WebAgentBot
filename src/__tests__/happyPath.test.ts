import { describe, it, expect, vi } from 'vitest';
import { MessageHandler } from '../../src/orchestrator/messageHandler.js';
import { WorkflowGuard } from '../../src/core/WorkflowGuard.js';

// Mocking the dependencies for MessageHandler
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

async function sendMessage(chatId: string, text: string) {
  return await handler.handle(chatId, text);
}

describe('Full website creation flow', () => {
  it('should complete discovery → design → domain → build', async () => {
    const chatId = 'test-happy-001';
    let currentPhase: any = 'discovery';

    // Helper to update mock state
    const updateState = (phase: string) => {
      currentPhase = phase;
      mockConversations.getOrCreate.mockResolvedValue({
        currentPhase: phase,
        projectState: {}
      });
    };

    // 1. Discovery phase
    updateState('discovery');
    mockRouter.classify.mockResolvedValue('provide_brand_info');
    mockRouter.route.mockReturnValue('discovery-agent');
    mockAgents.dispatch.mockResolvedValue({ 
      text: 'Tell me about your brand',
      nextPhase: 'discovery' 
    });

    await sendMessage(chatId, 'Hi I want a website');

    // 2. Transition to design_selection
    mockAgents.dispatch.mockResolvedValue({ 
      text: 'Got it! I am ready to show designs.',
      nextPhase: 'design_selection' 
    });
    await sendMessage(chatId, 'Flower shop called Bloom in Tel Aviv');
    
    // Advance phase manually in mock for next call
    updateState('design_selection');

    // 3. Design gate - presenting options
    mockRouter.classify.mockResolvedValue('general_question');
    mockRouter.route.mockReturnValue('design-agent');
    mockAgents.dispatch.mockResolvedValue({ 
      text: '🎨 Here are 3 design directions for Bloom:\nOption 1 — Modern\nOption 2 — Elegant\nOption 3 — Minimalist',
    });

    const designResponse = await sendMessage(chatId, 'That sounds great');
    expect(designResponse).toMatch(/option 1|option 2|option 3/i);
    
    // 4. Selection - User chooses "1"
    // IntentRouter has the fast-path for '1'
    mockRouter.classify.mockImplementation(async (msg, phase) => {
        if (phase === 'design_selection' && msg === '1') return 'select_design';
        return 'general_question';
    });
    mockRouter.route.mockReturnValue('design-agent');
    mockAgents.dispatch.mockResolvedValue({ 
      text: 'Great choice! What domain should we use?',
      nextPhase: 'domain_check'
    });

    const selectedResponse = await sendMessage(chatId, '1');
    expect(selectedResponse).toMatch(/domain|url|website address/i);
    updateState('domain_check');

    // 5. Domain check
    mockRouter.classify.mockResolvedValue('check_domain');
    mockRouter.route.mockReturnValue('domain-agent');
    mockAgents.dispatch.mockResolvedValue({ 
      text: 'bloomtelaviv.com is available. Build now?',
    });
    await sendMessage(chatId, 'bloomtelaviv.com');
    
    // 6. Build trigger
    mockRouter.classify.mockResolvedValue('approve_build');
    mockRouter.route.mockReturnValue('builder-agent');
    mockAgents.dispatch.mockResolvedValue({ 
      text: 'Creating your repository and building the site...',
      nextPhase: 'building'
    });

    const buildResponse = await sendMessage(chatId, 'Yes, build it!');
    expect(buildResponse).toMatch(/creating|building|repository/i);
    
  }, 60_000);
});

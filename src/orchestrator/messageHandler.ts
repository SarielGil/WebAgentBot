import { ConversationManager, WorkflowPhase, ProjectState, Message } from '../core/ConversationManager.js';
import { IntentRouter, Intent } from '../core/IntentRouter.js';
import { WorkflowGuard } from '../core/WorkflowGuard.js';

export interface AgentResponse {
  text: string;
  stateUpdates?: Partial<ProjectState>;
  nextPhase?: WorkflowPhase;
}

export interface AgentRegistry {
  dispatch(agentName: string, context: {
    history: Message[];
    projectState: ProjectState;
    userMessage: string;
    intent: Intent;
  }): Promise<AgentResponse>;
}

export class MessageHandler {
  constructor(
    private conversations: ConversationManager,
    private router: IntentRouter,
    private agents: AgentRegistry,
    private workflowGuard: WorkflowGuard = new WorkflowGuard(),
  ) {}

  async handle(chatId: string, userMessage: string) {
    // 1. Log user message into conversation
    await this.conversations.addMessage(chatId, 'user', userMessage);

    // 2. Get current state
    const state = await this.conversations.getOrCreate(chatId);

    // 3. Classify intent
    const intent = await this.router.classify(userMessage, state.currentPhase);

    // ✅ GATE: check if this intent is allowed in the current phase
    if (!this.workflowGuard.canProceed(intent, state.currentPhase)) {
      const blockedMessage = this.workflowGuard.getBlockedMessage(intent, state.currentPhase);
      await this.conversations.addMessage(chatId, 'assistant', blockedMessage);
      return blockedMessage;
    }

    const targetAgent = this.router.route(intent, state.currentPhase);

    // 4. Build full conversation history for the agent
    const history = await this.conversations.buildPromptHistory(chatId);

    // 5. Dispatch to agent with full context
    const agentResponse = await this.agents.dispatch(targetAgent, {
      history,
      projectState: state.projectState,
      userMessage,
      intent,
    });

    // 6. Log assistant response
    await this.conversations.addMessage(chatId, 'assistant', agentResponse.text);

    // 7. Apply any state mutations the agent returned
    if (agentResponse.stateUpdates) {
      await this.conversations.updateProjectState(chatId, agentResponse.stateUpdates);
    }
    if (agentResponse.nextPhase) {
      await this.conversations.advancePhase(chatId, agentResponse.nextPhase);
    }

    return agentResponse.text;
  }
}

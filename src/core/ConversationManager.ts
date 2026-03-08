export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface ConversationState {
  chatId: string;
  messages: Message[];
  projectState: ProjectState;
  currentPhase: WorkflowPhase;
  lastActive: number;
}

export type WorkflowPhase = 
  | 'discovery'
  | 'design_selection'
  | 'domain_check'
  | 'building'
  | 'deployed';

export interface ProjectState {
  brandName?: string;
  industry?: string;
  designChoice?: string;
  domain?: string;
  repoUrl?: string;
  mediaContext?: string; // summarized once from media uploads
}

export class ConversationManager {
  private store: Map<string, ConversationState> = new Map();
  private readonly MAX_MESSAGES = 20;
  private readonly SUMMARY_THRESHOLD = 15;

  async getOrCreate(chatId: string): Promise<ConversationState> {
    if (!this.store.has(chatId)) {
      this.store.set(chatId, {
        chatId,
        messages: [],
        projectState: {},
        currentPhase: 'discovery',
        lastActive: Date.now(),
      });
    }
    return this.store.get(chatId)!;
  }

  async addMessage(chatId: string, role: Message['role'], content: string) {
    const conv = await this.getOrCreate(chatId);
    conv.messages.push({ role, content, timestamp: Date.now() });
    conv.lastActive = Date.now();

    // Auto-summarize when too long
    if (conv.messages.length > this.SUMMARY_THRESHOLD) {
      await this.summarize(conv);
    }
  }

  async buildPromptHistory(chatId: string): Promise<Message[]> {
    const conv = await this.getOrCreate(chatId);
    // Always inject current project state as context
    const systemContext: Message = {
      role: 'system',
      content: `Current project state: ${JSON.stringify(conv.projectState)}\nCurrent phase: ${conv.currentPhase}`,
      timestamp: Date.now(),
    };
    return [systemContext, ...conv.messages.slice(-this.MAX_MESSAGES)];
  }

  async updateProjectState(chatId: string, updates: Partial<ProjectState>) {
    const conv = await this.getOrCreate(chatId);
    conv.projectState = { ...conv.projectState, ...updates };
  }

  async advancePhase(chatId: string, phase: WorkflowPhase) {
    const conv = await this.getOrCreate(chatId);
    conv.currentPhase = phase;
  }

  private async summarize(conv: ConversationState) {
    // Call Gemini to summarize older messages, keep recent ones
    // const toSummarize = conv.messages.slice(0, -5);
    // ... call your AI with toSummarize, get summary string
    // Replace old messages with a single system summary message
    const summary: Message = {
      role: 'system',
      content: `[Conversation summary]: ${/* AI summary result */ ''}`,
      timestamp: Date.now(),
    };
    conv.messages = [summary, ...conv.messages.slice(-5)];
  }
}

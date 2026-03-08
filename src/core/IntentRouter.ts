import { WorkflowPhase } from './ConversationManager.js';

export type Intent =
  | 'provide_brand_info'
  | 'select_design'
  | 'check_domain'
  | 'approve_build'
  | 'request_change'
  | 'general_question';

export class IntentRouter {
  private detectOptionSelection(message: string): boolean {
    const normalized = message.trim().toLowerCase();

    const directOptions = [
      '1',
      '2',
      '3',
      'option 1',
      'option 2',
      'option 3',
      'option one',
      'option two',
      'option three',
      'first',
      'second',
      'third',
      'the first',
      'the second',
      'the third',
      'one',
      'two',
      'three',
    ];

    if (directOptions.includes(normalized)) {
      return true;
    }

    return [
      /\b(option|design)\s*(1|2|3|one|two|three)\b/i,
      /\b(first|second|third)\s+(one|option|design)?\b/i,
      /\b(go with|choose|pick|take|prefer|select|i like|i want)\b[^.!?\n]{0,30}\b(1|2|3|one|two|three|first|second|third)\b/i,
    ].some((pattern) => pattern.test(message));
  }

  private detectDesignChangeRequest(message: string): boolean {
    return /\b(change|tweak|adjust|different|instead|combine|mix|edit|revise|refine|darker|lighter|warmer|cooler|color|palette|font|typography|layout|spacing|hero|button)\b/i.test(
      message,
    );
  }

  private looksLikeQuestion(message: string): boolean {
    return /\?|\b(which|what|why|how|can you|could you|compare|difference|better)\b/i.test(
      message,
    );
  }

  async classify(
    message: string,
    currentPhase: WorkflowPhase,
  ): Promise<Intent> {
    // Fast path: if we're in design_selection and user says "1", "2", or "3"
    if (currentPhase === 'design_selection') {
      if (this.detectDesignChangeRequest(message)) {
        return 'request_change';
      }

      if (this.detectOptionSelection(message)) {
        return 'select_design';
      }

      if (this.looksLikeQuestion(message)) {
        return 'general_question';
      }

      return 'general_question';
    }

    if (currentPhase === 'domain_check') {
      if (
        /\b(yes|build|go ahead|launch|ship it|proceed|looks good|do it)\b/i.test(
          message,
        )
      ) {
        return 'approve_build';
      }
      if (
        /\b(domain|url|\.com|\.co\.il|\.org|\.net|available|availability)\b/i.test(
          message,
        )
      ) {
        return 'check_domain';
      }
      return 'general_question';
    }

    if (currentPhase === 'building' || currentPhase === 'deployed') {
      if (/\b(change|tweak|update|revise|improve|redesign)\b/i.test(message)) {
        return 'request_change';
      }
      return 'general_question';
    }

    return 'provide_brand_info';
  }

  route(intent: Intent, phase: WorkflowPhase): string {
    const routingTable: Record<string, string> = {
      provide_brand_info: 'discovery-agent',
      select_design: 'design-agent',
      check_domain: 'domain-agent',
      approve_build: 'builder-agent',
      request_change: 'design-agent',
    };
    return routingTable[intent] ?? 'orchestrator';
  }
}

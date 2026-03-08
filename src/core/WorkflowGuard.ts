export type WorkflowPhase =
  | 'discovery'
  | 'design_selection'
  | 'domain_check'
  | 'building'
  | 'deployed';

export class WorkflowGuard {
  /**
   * Returns true if this action is allowed in the current phase
   */
  canProceed(action: string, phase: WorkflowPhase): boolean {
    const PHASE_GATES: Record<WorkflowPhase, string[]> = {
      discovery: ['provide_brand_info', 'general_question'],
      design_selection: ['select_design', 'request_change', 'general_question'],
      domain_check: ['check_domain', 'approve_build', 'general_question'],
      building: ['approve_build', 'general_question'],
      deployed: ['general_question'],
    };
    return PHASE_GATES[phase]?.includes(action) ?? false;
  }

  /**
   * Provides user-friendly feedback when an action is blocked by the current phase.
   */
  getBlockedMessage(action: string, phase: WorkflowPhase): string {
    if (phase === 'design_selection' && action === 'approve_build') {
      return "Please choose a design direction first. Reply with 1, 2, or 3 — or say something like 'option 2 with warmer colors' before building starts.";
    }
    return "Let's finish the current step first.";
  }
}

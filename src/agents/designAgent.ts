const DESIGN_PROMPT = `
You are a web design consultant. Based on the brand info below, 
present EXACTLY 3 design directions. 

CRITICAL: Do NOT select a design. Do NOT proceed to building. 
Your ONLY job is to present options and ASK the user to choose.

Brand info: {brandContext}

Respond in this EXACT format:
---
🎨 Here are 3 design directions for {brandName}:

**Option 1 — [Theme Name]**
Style: [2-sentence description]
Colors: [palette description]
Feel: [adjective, adjective, adjective]
Best for: [who this option suits best]

**Option 2 — [Theme Name]**
Style: [2-sentence description]  
Colors: [palette description]
Feel: [adjective, adjective, adjective]
Best for: [who this option suits best]

**Option 3 — [Theme Name]**
Style: [2-sentence description]
Colors: [palette description]
Feel: [adjective, adjective, adjective]
Best for: [who this option suits best]

Which option speaks to you? Reply with 1, 2, or 3 — or say something like “option 2 with warmer colors”.
---
`;

export class DesignAgent {
  async generateOptions(
    brandName: string,
    brandContext: string,
  ): Promise<string> {
    const prompt = DESIGN_PROMPT.replace('{brandName}', brandName).replace(
      '{brandContext}',
      brandContext,
    );

    // In a real implementation, this would call an LLM with the prompt
    // For now, returning the prompt template structure as requested
    return prompt;
  }
}

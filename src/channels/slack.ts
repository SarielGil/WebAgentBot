import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

export class SlackChannel {
  private webhookUrl?: string;

  constructor() {
    const envs = readEnvFile(['SLACK_WEBHOOK_URL']);
    this.webhookUrl = envs.SLACK_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;

    if (!this.webhookUrl) {
      logger.warn(
        'SLACK_WEBHOOK_URL not found, escalation alerts will be disabled.',
      );
    }
  }

  async sendEscalation(
    chatJid: string,
    userName: string,
    text: string,
  ): Promise<boolean> {
    if (!this.webhookUrl) return false;

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🚨 *Admin Escalation Required* 🚨\n\n*User:* ${userName} (${chatJid})\n*Issue:* ${text}\n\nPlease check the dashboard or log into the Telegram bot to assist.`,
        }),
      });

      if (!response.ok) {
        throw new Error(`Slack webhook returned status ${response.status}`);
      }

      logger.info({ chatJid }, 'Escalation alert sent to Slack');
      return true;
    } catch (err) {
      logger.error({ err, chatJid }, 'Failed to send Slack escalation');
      return false;
    }
  }
}

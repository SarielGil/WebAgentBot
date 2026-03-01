import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { GoogleGenerativeAI, Tool, SchemaType } from '@google/generative-ai';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  mediaPath?: string;
  mediaMetadata?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const IPC_POLL_MS = 500;

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filename;
}

const tools: Tool[] = [
  {
    functionDeclarations: [
      {
        name: 'send_message',
        description: 'Send a message to the user immediately.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            text: { type: SchemaType.STRING, description: 'The message text to send' },
          },
          required: ['text'],
        },
      },
      {
        name: 'github_create_repo',
        description: 'Create a new GitHub repository.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            name: { type: SchemaType.STRING, description: 'The repository name' },
            description: { type: SchemaType.STRING, description: 'The repository description' },
          },
          required: ['name'],
        },
      },
      {
        name: 'slack_escalate',
        description: 'Escalate an issue to the admin via Slack.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            reason: { type: SchemaType.STRING, description: 'The reason for escalation' },
          },
          required: ['reason'],
        },
      },
      {
        name: 'bash',
        description: 'Execute a bash command in the local container environment.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            command: { type: SchemaType.STRING, description: 'The command to execute' },
          },
          required: ['command'],
        },
      },
      {
        name: 'read_file',
        description: 'Read the contents of a file.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            path: { type: SchemaType.STRING, description: 'The absolute path to the file' },
          },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Write content to a file.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            path: { type: SchemaType.STRING, description: 'The absolute path to the file' },
            content: { type: SchemaType.STRING, description: 'The content to write' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'check_domain',
        description: 'Check if a domain name is likely available (DNS lookup).',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            domain: { type: SchemaType.STRING, description: 'The domain name (e.g. google.com)' },
          },
          required: ['domain'],
        },
      },
      {
        name: 'web_search',
        description: 'Search the web for information about a business or brand.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            query: { type: SchemaType.STRING, description: 'The search query' },
          },
          required: ['query'],
        },
      }
    ],
  },
];

async function handleToolCall(name: string, args: any, input: ContainerInput): Promise<any> {
  log(`Tool call: ${name} with ${JSON.stringify(args)}`);
  switch (name) {
    case 'send_message':
      writeIpcFile(MESSAGES_DIR, {
        type: 'message',
        chatJid: input.chatJid,
        text: args.text,
        groupFolder: input.groupFolder,
        timestamp: new Date().toISOString()
      });
      return { success: true, message: 'Message queued for delivery' };

    case 'github_create_repo':
      writeIpcFile(TASKS_DIR, {
        type: 'github_create_repo',
        chatJid: input.chatJid,
        repoName: args.name,
        repoDescription: args.description,
        timestamp: new Date().toISOString()
      });
      return { success: true, message: 'Repository creation request sent to host.' };

    case 'slack_escalate':
      writeIpcFile(TASKS_DIR, {
        type: 'slack_escalate',
        chatJid: input.chatJid,
        reason: args.reason,
        timestamp: new Date().toISOString()
      });
      return { success: true, message: 'Escalation sent to admin.' };

    case 'bash':
      try {
        const stdout = execSync(args.command, { encoding: 'utf-8', timeout: 30000 });
        return { stdout };
      } catch (err: any) {
        return { error: err.message, stderr: err.stderr, stdout: err.stdout };
      }

    case 'read_file':
      try {
        const content = fs.readFileSync(args.path, 'utf-8');
        return { content };
      } catch (err: any) {
        return { error: err.message };
      }

    case 'write_file':
      try {
        fs.mkdirSync(path.dirname(args.path), { recursive: true });
        fs.writeFileSync(args.path, args.content);
        return { success: true };
      } catch (err: any) {
        return { error: err.message };
      }

    case 'check_domain':
      writeIpcFile(TASKS_DIR, {
        type: 'domain_check',
        chatJid: input.chatJid,
        domain: args.domain,
        timestamp: new Date().toISOString()
      });
      return { success: true, message: 'Domain check request sent.' };

    case 'web_search':
      writeIpcFile(TASKS_DIR, {
        type: 'web_search',
        chatJid: input.chatJid,
        query: args.query,
        timestamp: new Date().toISOString()
      });
      return { success: true, message: 'Web search request sent to host.' };

    default:
      return { error: `Tool ${name} not implemented` };
  }
}

async function runChatLoop(ai: GoogleGenerativeAI, input: ContainerInput): Promise<void> {
  const model = ai.getGenerativeModel({
    model: 'gemini-2.0-flash', // Updated to 2.0
    tools: tools,
  });

  let systemInstruction = "You are a helpful assistant.";
  const globalMd = '/workspace/global/GEMINI.md';
  const localMd = '/workspace/group/GEMINI.md';
  const roadmapMd = '/workspace/global/ROADMAP.md';
  if (fs.existsSync(globalMd)) systemInstruction += '\n' + fs.readFileSync(globalMd, 'utf-8');
  if (fs.existsSync(roadmapMd)) systemInstruction += '\n\n## CURRENT ROADMAP STATUS\n' + fs.readFileSync(roadmapMd, 'utf-8');
  if (fs.existsSync(localMd)) systemInstruction += '\n' + fs.readFileSync(localMd, 'utf-8');

  const chat = model.startChat({
    history: [],
    generationConfig: {
      maxOutputTokens: 2048,
    },
  });

  let prompt = input.prompt;
  if (input.isScheduledTask) prompt = `[SCHEDULED TASK]\n\n${prompt}`;

  // Handle Multimodal Media
  let messageContent: any[] = [prompt];
  if (input.mediaPath && fs.existsSync(input.mediaPath)) {
    const fileData = fs.readFileSync(input.mediaPath);
    const mimeType = input.mediaPath.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg';
    messageContent.push({
      inlineData: {
        data: fileData.toString('base64'),
        mimeType: mimeType
      }
    });

    if (!input.mediaMetadata) {
      // Analysis Turn
      messageContent = [
        `Please analyze this media file and provide a concise technical description/summary. 
        Focus on brand elements, color palettes, and business context if relevant.
        Your response will be stored as metadata for future turns to avoid resending this file.`,
        {
          inlineData: {
            data: fileData.toString('base64'),
            mimeType: mimeType
          }
        }
      ];
    }
  }

  try {
    let result = await chat.sendMessage(messageContent);

    while (result.response.candidates?.[0]?.content?.parts?.some(p => p.functionCall)) {
      const calls = result.response.candidates[0].content.parts.filter(p => p.functionCall);
      const toolResponses = await Promise.all(calls.map(async (call) => {
        const response = await handleToolCall(call.functionCall!.name, call.functionCall!.args, input);
        return {
          functionResponse: {
            name: call.functionCall!.name,
            response: response
          }
        };
      }));

      result = await chat.sendMessage(toolResponses);
    }

    writeOutput({
      status: 'success',
      result: result.response.text(),
    });
  } catch (err: any) {
    log(`Chat error: ${err.message}`);
    writeOutput({
      status: 'error',
      result: null,
      error: err.message
    });
  }
}

async function main(): Promise<void> {
  const stdinData = await new Promise<string>((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });

  const input: ContainerInput = JSON.parse(stdinData);
  const apiKey = input.secrets?.GEMINI_API_KEY;
  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'GEMINI_API_KEY missing' });
    process.exit(1);
  }

  const ai = new GoogleGenerativeAI(apiKey);
  await runChatLoop(ai, input);
}

main().catch(err => {
  log(`Fatal error: ${err}`);
  process.exit(1);
});

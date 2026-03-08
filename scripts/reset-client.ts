#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR, STORE_DIR } from '../src/config.js';
import { assertValidGroupFolder } from '../src/group-folder.js';

function usage(): never {
  console.error(
    'Usage: tsx scripts/reset-client.ts <group-folder> [chat-jid] [--hard]',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const hardReset = args.includes('--hard');
const positional = args.filter((arg) => arg !== '--hard');

const groupFolder = positional[0];
const chatJid = positional[1];

if (!groupFolder) {
  usage();
}

assertValidGroupFolder(groupFolder);

const dbPath = path.join(STORE_DIR, 'messages.db');
const groupPath = path.join(GROUPS_DIR, groupFolder);
const groupSessionsPath = path.join(DATA_DIR, 'sessions', groupFolder);
const groupMediaPath = path.join(DATA_DIR, 'media', groupFolder);

function removePath(targetPath: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function stopGroupContainers(folder: string): string[] {
  try {
    const output = execSync(
      `docker ps --format '{{.Names}}' | grep '^nanoclaw-${folder}-' || true`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    const names = output.split('\n').filter(Boolean);
    for (const name of names) {
      execSync(`docker stop ${name}`, { stdio: 'pipe' });
    }
    return names;
  } catch {
    return [];
  }
}

const stoppedContainers = stopGroupContainers(groupFolder);

const geminiHistoryPaths = fs.existsSync(groupPath)
  ? fs.readdirSync(groupPath)
      .filter((name) => name === '.gemini-chat-history.json' || name.startsWith('.gemini-chat-history.'))
      .map((name) => path.join(groupPath, name))
  : [];

for (const historyPath of geminiHistoryPaths) {
  removePath(historyPath);
}

removePath(groupSessionsPath);

if (hardReset) {
  removePath(groupMediaPath);
}

const db = new Database(dbPath);

try {
  db.prepare('DELETE FROM sessions WHERE group_folder = ? OR group_folder LIKE ?').run(
    groupFolder,
    `${groupFolder}::%`,
  );

  const routerStateRow = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get('last_agent_timestamp') as { value?: string } | undefined;
  if (routerStateRow?.value) {
    try {
      const parsed = JSON.parse(routerStateRow.value) as Record<string, string>;
      delete parsed[groupFolder];
      db.prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)').run(
        'last_agent_timestamp',
        JSON.stringify(parsed),
      );
    } catch {
      // Ignore malformed state; runtime will reset it on startup if needed.
    }
  }

  if (hardReset) {
    if (chatJid) {
      db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
      db.prepare('DELETE FROM chats WHERE jid = ?').run(chatJid);
    } else {
      const registered = db
        .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
        .get(groupFolder) as { jid?: string } | undefined;
      if (registered?.jid) {
        db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(registered.jid);
        db.prepare('DELETE FROM chats WHERE jid = ?').run(registered.jid);
      }
    }
  }
} finally {
  db.close();
}

console.log(`Reset complete for group: ${groupFolder}`);
if (chatJid) {
  console.log(`Chat JID: ${chatJid}`);
}
console.log(`Stopped containers: ${stoppedContainers.length > 0 ? stoppedContainers.join(', ') : '(none)'}`);
for (const historyPath of geminiHistoryPaths) {
  console.log(`Removed: ${historyPath}`);
}
console.log(`Removed: ${groupSessionsPath}`);
if (hardReset) {
  console.log(`Hard reset: enabled`);
  console.log(`Removed: ${groupMediaPath}`);
  console.log('Deleted DB chat/message history for this group when a JID was available.');
} else {
  console.log('Soft reset: preserved stored message history and chat metadata.');
}
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  setSession,
  getSession,
  getAllSessions,
  getSessionScopeKey,
} from './db.js';

describe('Session with Summary', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stores and retrieves a session with a summary', () => {
    const folder = 'test-group';
    const sessionId = 'session-123';
    const summary = 'This project is about a bakery with pastel colors.';

    setSession(folder, sessionId, summary);

    const session = getSession(folder);
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe(sessionId);
    expect(session!.summary).toBe(summary);
  });

  it('updates summary for existing session', () => {
    const folder = 'test-group';
    setSession(folder, 's1', 'first summary');
    setSession(folder, 's1', 'second summary');

    const session = getSession(folder);
    expect(session!.summary).toBe('second summary');
  });

  it('retrieves all sessions correctly', () => {
    setSession('group1', 's1', 'summary 1');
    setSession('group2', 's2', 'summary 2');

    const sessions = getAllSessions();
    expect(Object.keys(sessions)).toHaveLength(2);
    expect(sessions['group1'].summary).toBe('summary 1');
    expect(sessions['group2'].summary).toBe('summary 2');
  });

  it('stores and retrieves chat-scoped sessions without leaking to other chats', () => {
    const folder = 'client1';
    const chatA = 'chat-a';
    const chatB = 'chat-b';

    setSession(folder, 'session-a', 'summary a', chatA);
    setSession(folder, 'session-b', 'summary b', chatB);

    expect(getSession(folder, chatA)?.sessionId).toBe('session-a');
    expect(getSession(folder, chatB)?.sessionId).toBe('session-b');

    const sessions = getAllSessions();
    expect(sessions[getSessionScopeKey(folder, chatA)].summary).toBe(
      'summary a',
    );
    expect(sessions[getSessionScopeKey(folder, chatB)].summary).toBe(
      'summary b',
    );
  });

  it('falls back to legacy group-scoped sessions when a chat-scoped session is missing', () => {
    const folder = 'legacy-group';
    setSession(folder, 'legacy-session', 'legacy summary');

    const session = getSession(folder, 'new-chat');
    expect(session?.sessionId).toBe('legacy-session');
    expect(session?.summary).toBe('legacy summary');
  });
});

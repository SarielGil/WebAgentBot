import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase, setSession, getSession, getAllSessions } from './db.js';

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
});

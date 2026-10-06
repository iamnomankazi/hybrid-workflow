// Summaries of Codex `exec --json` stdout (JSONL) and quota/auth failure classification.
import { readJsonlFrom } from './fsutil.mjs';

const AUTH_RE = /\b401\b|unauthori[sz]ed|invalid_grant|refresh[ _-]?token|not logged in|log ?in again|re-?authenticat|authentication (failed|required|error)|token (has )?expired|please sign in/i;
const QUOTA_RE = /usage limit|rate[ _-]?limit|quota|insufficient_quota|too many requests|\b429\b|limit (has been )?reached|purchase more credits/i;

const MAX_ERROR_CHARS = 500;
const MAX_MESSAGE_CHARS = 2000;

// Codex retries connection problems internally and reports each attempt as an `error` event.
export function isTransientMessage(message) {
  return message.startsWith('Reconnecting...') || message.startsWith('Falling back from WebSockets');
}

export function classifyFailure(messages) {
  const real = messages.filter((m) => typeof m === 'string' && !isTransientMessage(m));
  if (real.some((m) => AUTH_RE.test(m))) return 'auth';
  if (real.some((m) => QUOTA_RE.test(m))) return 'quota';
  return null;
}

export function summarizeEvents(records, { maxErrors = 5 } = {}) {
  const out = {
    count: 0,
    thread_id: null,
    turn_started: false,
    turn_completed: false,
    turn_failed: false,
    failure_message: null,
    errors: [],
    usage: null,
    item_types: {},
    last_agent_message: null,
    classification: null,
    mcp_tool_calls: 0,
  };
  const messages = [];
  const itemTypeById = new Map();
  const note = (message) => {
    if (typeof message === 'string' && message) messages.push(message);
  };

  for (const rec of records) {
    out.count++;
    switch (rec?.type) {
      case 'thread.started':
        out.thread_id ??= rec.thread_id ?? null;
        break;
      case 'turn.started':
        out.turn_started = true;
        break;
      case 'turn.completed':
        out.turn_completed = true;
        out.usage = rec.usage ?? null;
        break;
      case 'turn.failed': {
        out.turn_failed = true;
        const message = rec.error?.message ?? rec.message ?? null;
        out.failure_message = message;
        note(message);
        break;
      }
      case 'error':
        note(rec.message);
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = rec.item;
        if (!item || typeof item.type !== 'string') break;
        itemTypeById.set(item.id ?? `anon-${out.count}`, item.type);
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          out.last_agent_message = item.text.slice(0, MAX_MESSAGE_CHARS);
        }
        if (item.type === 'error' && rec.type === 'item.completed') note(item.message);
        break;
      }
      default:
        break;
    }
  }

  for (const type of itemTypeById.values()) out.item_types[type] = (out.item_types[type] ?? 0) + 1;
  out.mcp_tool_calls = out.item_types.mcp_tool_call ?? 0;
  out.errors = messages.slice(-maxErrors).map((m) => ({
    message: m.slice(0, MAX_ERROR_CHARS),
    transient: isTransientMessage(m),
  }));
  out.classification = out.turn_completed ? null : classifyFailure(messages);
  return out;
}

export function summarizeEventsFile(file, opts) {
  const { records, nextOffset, malformed } = readJsonlFrom(file, 0);
  return { ...summarizeEvents(records, opts), malformed, bytes: nextOffset };
}

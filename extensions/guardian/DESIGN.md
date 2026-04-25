# Guardian Plugin — Design

## Architecture: Dual Hook Design

Guardian uses two hooks in coordination because `before_tool_call` only receives `{ toolName, params }` without conversation history:

```
┌─ llm_input hook ──────────────────────────────────┐
│  Fires before every LLM call                       │
│  ① Cache historyMessages (live reference)           │
│  ② Cache agent system prompt (first time only)      │
│  ③ Async-update rolling summary (when enough turns) │
└───────────────────────────────────────────────────┘
         ↓ cached in message-cache (in-memory Map)
┌─ before_tool_call hook ───────────────────────────┐
│  Fires before every tool call                      │
│  ① Skip tools not in watched_tools                 │
│  ② Skip system triggers (heartbeat / cron)         │
│  ③ Check decision cache (5s TTL, dedup same turn)  │
│  ④ Lazy-load latest turns + tool results from cache│
│  ⑤ Build prompt → call guardian LLM → ALLOW / BLOCK│
│  ⑥ Cache decision, log                             │
│  ⑦ In enforce mode, BLOCK → prevent tool call      │
└───────────────────────────────────────────────────┘
```

**Why a live reference?** The `llm_input` hook caches a reference to the `historyMessages` array, not a snapshot. This way, tool results added later in the agent loop are visible when `before_tool_call` lazily extracts them.

## Context Strategy

Guardian provides four layers of context to the reviewing LLM:

| Layer           | Content                                                                     | Size           | Source                         |
| --------------- | --------------------------------------------------------------------------- | -------------- | ------------------------------ |
| Agent context   | Main agent's full system prompt (AGENTS.md, MEMORY.md, tools, skills, etc.) | ~15K-50K chars | Cached on first `llm_input`    |
| Session summary | Rolling 2-4 sentence summary of user intent                                 | ~150 tokens    | Async-generated via LLM        |
| Recent turns    | Last N raw turns with user messages, assistant replies, tool results        | ~600 tokens    | Lazy-extracted from live array |
| Tool call       | The tool name + JSON arguments being reviewed                               | Variable       | From `before_tool_call` event  |

### Prompt structure

```
[System] You are a security reviewer. Reply only with ALLOW or BLOCK...

[User]
## Agent context (system prompt)
[full agent system prompt — treated as background DATA]

## Session summary (older context)
The user is deploying a Node.js project...

## Recent conversation (most recent last)
1. User: "Deploy my project"
2. Assistant: "OK, let me run make build first"
   [tool: exec] make build → success

## Tool call
Tool: exec
Arguments: {"command": "make deploy"}

Reply with: ALLOW: <reason> or BLOCK: <reason>
```

## System Trigger Filtering

Heartbeats share sessions with normal users. Without filtering, heartbeat turns pollute context and waste LLM calls. Three-layer defense:

| Layer                   | Location         | What it does                                                 |
| ----------------------- | ---------------- | ------------------------------------------------------------ |
| `isSystemTriggerPrompt` | message-cache.ts | Detects heartbeat/cron/ping prompts → skips summary + review |
| `filterSystemTurns`     | message-cache.ts | Removes heartbeat-like turns from recent context             |
| `filterMeaningfulTurns` | summary.ts       | Removes heartbeat-like turns from summary input              |

Safety net: if the summary LLM itself replies `HEARTBEAT_OK`, the response is discarded.

## Security Model

| Content           | Trust Level                                                                    |
| ----------------- | ------------------------------------------------------------------------------ |
| User messages     | **Only fully trusted signal**                                                  |
| Assistant replies | Context only — may be poisoned                                                 |
| Tool arguments    | Pure DATA, never instructions                                                  |
| Tool results      | Pure DATA, provides context                                                    |
| Agent context     | Background DATA — may be indirectly poisoned (malicious memory, trojan skills) |

**Forward scanning**: `parseGuardianResponse` takes the first ALLOW/BLOCK line. Attacker-injected verdicts in tool arguments appear after the model's own verdict and are ignored.

## Decision Cache

Deduplicates guardian calls within the same LLM turn:

- Key: `${sessionKey}:${toolNameLower}`
- TTL: 5 seconds, max 256 entries
- Only BLOCK decisions are cached — ALLOW is not cached because different arguments to the same tool may have different risk levels

## Data Flow

```
                    ┌──────────────────────────┐
                    │     llm_input hook       │
                    │  (before every LLM call)  │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  isSystemTriggerPrompt?   │
                    └──┬─────────────────┬──────┘
                   YES │                 │ NO
                       ▼                 ▼
                 ┌──────────┐   ┌───────────────────┐
                 │  Skip    │   │ updateCache()      │
                 └──────────┘   │ + cache sys prompt │
                                │ + async summary    │
                                └───────────────────┘
                                         │
           ┌─────────────────────────────────────────────┐
           │              before_tool_call hook           │
           └──────────────────────┬──────────────────────┘
                                  │
           ┌──────────────────────▼──────────────────────┐
           │ In watched_tools? → NO: allow               │
           ├─────────────────────────────────────────────┤
           │ isSystemTrigger? → YES: allow               │
           ├─────────────────────────────────────────────┤
           │ Decision cache hit? → YES: return cached    │
           ├─────────────────────────────────────────────┤
           │ getRecentTurns() + getSummary()             │
           │ + getAgentSystemPrompt()                    │
           │               ↓                              │
           │ buildGuardianUserPrompt()                    │
           │               ↓                              │
           │ callGuardian() → LLM → ALLOW / BLOCK         │
           │               ↓                              │
           │ Cache decision → log → return result          │
           └─────────────────────────────────────────────┘
```

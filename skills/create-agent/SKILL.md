---
name: create-agent
description: Create, adjust, list or look up the user's saved agents. Use when the user asks to make or set up an agent, change what an agent can do, choose which tools or connected apps an agent may use, or see their agents.
user-invocable: true
---

# Create an agent

A saved agent is a reusable setup: a name, an avatar (an `icon` and a `color` that fit its job, for example `mail` and `teal` for an inbox agent), instructions, a model, the tools it may use and the apps it may use. The user picks it later when starting a chat. You build it with them, step by step, and save it only after they say yes.

## What you can do

- `agent_tools`: the tools this chat can use, and the MCP servers behind some of them.
- `agent_list` and `agent_get`: look up the user's saved agents.
- `agent_create` and `agent_update`: save a new agent or change one. The user gets an approval prompt for each; if they decline, nothing is saved.

You cannot delete agents, add MCP servers, or put keys or credentials into an agent. If asked, say so and point to the Plugins page (Connectors tab) for connecting apps.

## Before you start

Call `agent_list`. If an agent already does something close to the request, tell the user and offer to adjust it (see "Changing an agent") instead of making a near copy.

## Step 1: Understand what they want

Ask short questions with `ask_user_question` (if that tool is not available, ask in the chat). Offer concrete choices, not open prompts. Ask only what you do not already know, at most four questions in one round:

- What is the agent for? One sentence on the job, and who it is for.
- What may it do? Read and report only, change files, or run commands and tests too.
- What should it never do? Anything off limits (deleting files, sending email without asking, touching production).
- How should it answer? Short summary, detailed report, or a checklist.

Then propose a name (two to four words) and let them change it.

## Step 2: See what is available

Call `agent_tools`. It returns the tools you can offer and an `mcp_servers` list (each server and how many tools it provides). Explain the result in plain words, grouped by purpose: reading and searching files, changing files, running commands, the web, scheduling, skills, subagents. Do not paste raw tool lists.

### Apps and MCP servers

Work out what is connected, then tell the user in three groups.

1. **Composio apps** (Gmail, GitHub, Google Drive, and so on). If `mcp_servers` includes `composio`, call `COMPOSIO_MANAGE_CONNECTIONS` with action `list` for the apps that could matter for this agent (name them yourself from the job, for example `gmail` for an inbox agent). Only `list` is safe here: never use the default `add` action to check status, because it creates a connection link.
2. **Other MCP servers.** List each by name with what it offers (tool count and two or three tool names).
3. **Nothing connected.** If there are no MCP servers at all, say so: apps cannot be listed from this chat. Tell the user they can connect apps in Settings, Connectors, and ask you again.

Report three short lists:

- **Connected and useful for this agent** (say why).
- **Connected, probably not needed** (one line, so they can still pick one).
- **Not connected but would help** (name the app and what it would let the agent do).

## Step 3: Ask what to include

For each connected app or MCP server that could help, ask whether to include it, with a multi-select question. Be honest about what "include" means: the agent is told to prefer those apps. It is a strong hint, not a lock, and it does not disconnect anything for other chats.

For an app that would help but is not connected, offer to connect it. Only after the user says yes, call `COMPOSIO_MANAGE_CONNECTIONS` for that app to get the connection link and give it to them. Ask them to tell you when they are done, then check again with action `list` before including it. If they decline, carry on without it.

## Step 4: Choose the tools

Pick the smallest set that does the job. Never request a tool that `agent_tools` did not list, and never include `agent_*` tools.

- Review, research and planning agents: reading and searching tools only.
- Add file-changing tools only if the agent must edit files or produce documents.
- Add the shell only if it must run commands or tests.
- Add web tools only for agents that look things up.
- Turn on subagents (with a small maximum, usually 2 or 3) only when the work splits into parts that can run at the same time, such as researching several sources.

Tell the user the choice in plain words, and why, before you save.

## Step 5: Write the instructions

Write them as a short brief the agent reads every time. Use this shape, in plain text, under about 400 words:

- Role: one line on what the agent is.
- How to work: three to six concrete steps, in order.
- Boundaries: what it must not do, and when it should stop and ask.
- Output: what its answer should look like.

Be specific to the job. Do not list the tools (they are set separately). Do not include keys, passwords or private links.

## Step 6: Show the draft and get a yes

Show it clearly: name, one-line summary, model (leave the default unless they asked for another), tools in plain words, apps, subagents, then the instructions in a block. Ask them to confirm or say what to change, and revise until they confirm. Do not save before that.

## Step 7: Save and report

Call `agent_create`. The user will see an approval prompt. If it is declined, nothing was saved: ask what they want to change.

After it saves, say the agent's name and what it can use, that they can choose it from the agent menu when starting a new chat, and that they can edit it on the Agents page or ask you to change it.

## Changing an agent

Use `agent_list` to find it and `agent_get` to read it. Show what is there now next to what you would change, and wait for a yes. Then call `agent_update` with only the fields that change.

## If something goes wrong

Say what happened in plain words and what to try next. A tool name that is rejected means it is not available in this chat: choose another or leave it out. Never retry the same failing call more than once.

## Examples

A pull request reviewer: ask what languages and how strict; offer read-only tools and no shell; suggest GitHub if connected; write a brief that says to read the diff and its surroundings, report by impact, cite file and line, and not edit anything.

An inbox helper: Gmail is connected, so ask whether to include it; offer read tools only so it cannot send or delete; if Gmail is not connected, offer to connect it first and wait.

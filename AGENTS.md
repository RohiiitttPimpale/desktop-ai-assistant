# CRITICAL RULES - MUST FOLLOW

## RESPONSES

- Keep responses concise and to the point - unless the user asks otherwise
- Report what changed and what was actually verified
- Never claim something works without evidence

## PLANNING MODE

- Always ask clarifying questions when the answer would change the design
- Never assume design, tech stack or features
- Inspect the existing code before proposing anything
- Do not implement while planning - wait for the user's approval
- Use sub-agents to assist with research
- Use sub-agents to review the different aspects of your plan before presenting to the user
- Never change the project's chosen tech stack without explicit approval

## CHANGE / EDIT MODE

- Make the smallest complete change
- Reuse existing code - never create a duplicate of something that already exists
- No large rewrites without a clear reason
- Use sub-agents only for research, independent review, or parallel work on separate files - not for small fixes
- Never let two agents edit the same file
- When using sub-agents, the main agent owns integration and final verification
- After completing features (large or small), always run lint, type check and build to check code quality
- Review the final diff before finishing

## PROJECT SCOPE

- Work on the current phase only - never jump ahead unless the user asks
- Miko is a general-purpose assistant - never hard-code a workflow for one task (like "assignment mode" or "send to Panda")
- Solve new tasks by combining existing tools - if one is missing, add a small, general, separate tool
- Never change the agent core just to support one new workflow
- Examples in the docs are demonstrations, not fixed workflows

## TOOLS

- Every tool must have a name, description, input rules, risk level, timeout and logging
- Use the most reliable method first: dedicated tool, then browser automation, then app controls - screenshots with mouse/keyboard only as a last resort
- Tool results must be short and structured
- Errors go back to the AI as text so it can replan - never retry blindly
- The AI never writes document-file code - it outputs structured blocks and our renderer builds the file
- Verify a created file exists and opens before reporting success

## SAFETY AND PERMISSIONS

- Every tool call must go through the permission gate - never bypass it
- Risk levels: READ, NORMAL, SENSITIVE, DANGEROUS
- Always ask the user before SENSITIVE actions (sending files/messages, uploads, installs, running code)
- DANGEROUS actions (delete, shell, registry, format) always ask and are never whitelisted
- The permission mode (Strict / Normal / Full) never overrides a risk level
- Never put secrets in code, logs, docs, Git or prompts to the AI
- Never run AI-generated shell commands without validation and permission
- Contacts must match exactly - if ambiguous, stop and ask, never guess
- Before sending anything, verify the recipient, the file and the content
- Never say an action succeeded without verifying the result

## SETTINGS

- `MIKO_VISIBLE=true` for now - browser and WhatsApp automation stay visible. Do not change it until the user says the project is finished
- `DRY_RUN` does everything except sending messages or files

## TESTING

- Use any testing tools available to the project for testing your changes
- Never assume your changes simply work, always test!
- Never fabricate test results
- Tests must never send real messages, upload real files or delete real data - use mocks or `DRY_RUN`
- If there is no way to test a change, do the closest manual check and say so, or ask the user whether testing should be skipped

## UI DESIGN

- Keep the avatar and its existing interactions unchanged unless the user asks
- No UI changes unrelated to the requested feature

## DOCS

- Full design: `docs/blueprint.md`
- Build phases: `docs/phases.md`
- If they conflict with this file, this file wins

## CURRENT PHASE

- Phase 2: permission engine hardening - enforce the per-tool timeout from `policy.json` inside the registry
- Done when a slow test tool is cut off at its timeout, the SENSITIVE confirm gate still passes, and tests and type check pass
- Out of scope until then: voice, WhatsApp, documents, browser work, memory, tool discovery
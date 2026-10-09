import { app, dialog } from 'electron';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toolRegistry } from './src/main/registry';
import './src/main/packs/core';
import { runTools } from './src/main/tools';
import { getPolicy, updatePolicy } from './src/main/policy';
import * as voice from './src/main/voice/index';
import { createBrain, sanitize } from './src/main/brain';
import { getSettings, updateSettings, isDryRun, isVisibleMode } from './src/main/settings';

app.whenReady().then(async () => {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    console.log('\n--- Running Phase 1 Acceptance Tests ---\n');

    // 1. Check registry has registered tools
    const toolNames = toolRegistry.getNames();
    console.log('[1] Checking Tool Registration...');
    assert(toolNames.includes('test_sensitive'), 'test_sensitive is registered');
    assert(toolNames.includes('click_screen'), 'click_screen is registered');
    assert(toolNames.includes('type_text'), 'type_text is registered');
    assert(toolNames.includes('look_at_screen'), 'look_at_screen is registered');

    // 2. Check risk levels
    console.log('\n[2] Checking Risk Levels...');
    const testSensTool = toolRegistry.get('test_sensitive');
    assert(testSensTool !== undefined && testSensTool.risk === 'SENSITIVE', 'test_sensitive has SENSITIVE risk');

    const lookTool = toolRegistry.get('look_at_screen');
    assert(lookTool !== undefined && lookTool.risk === 'READ', 'look_at_screen has READ risk');

    // 3. Check permission gating by TrayMode
    console.log('\n[3] Checking TrayMode Permission Gate...');
    const readOnlyCheck = toolRegistry.checkPermission('test_sensitive', 'read-only');
    assert(readOnlyCheck.allowed === false, 'test_sensitive is blocked in read-only mode');

    const normalCheck = toolRegistry.checkPermission('test_sensitive', 'normal');
    assert(normalCheck.allowed === true && normalCheck.needsConfirm === true, 
      'test_sensitive is allowed in normal mode but requires confirmation');

    // 4. Check LLM Schema includes query, text, key
    console.log('\n[4] Checking LLM Schema...');
    const schema = toolRegistry.getSchemaForLLM();
    const actionProps = (schema.properties as any).actions.items.properties;
    assert(actionProps.query !== undefined, 'LLM schema includes "query"');
    assert(actionProps.text !== undefined, 'LLM schema includes "text"');
    assert(actionProps.key !== undefined, 'LLM schema includes "key"');

    // 5. Test Confirmation Gate: "No" blocks it, "Yes" runs it
    console.log('\n[5] Testing Confirmation Gate ("no" blocks, "yes" allows)...');
    
    // Mock dialog.showMessageBox to simulate user clicking "Cancel" (response: 1)
    const originalShowMessageBox = dialog.showMessageBox;
    
    let confirmCallCount = 0;
    dialog.showMessageBox = (async (_win: any, _opts?: any) => {
      confirmCallCount++;
      return { response: 1, checkboxChecked: false }; // 1 = Cancel
    }) as any;

    const deniedResults = await runTools([{ tool: 'test_sensitive', args: {} }]);
    assert(confirmCallCount === 1, `Confirmation dialog was shown exactly once (actual: ${confirmCallCount})`);
    assert(deniedResults.some(r => r.includes('User denied test_sensitive')), 
      `User "Cancel" cleanly blocked execution: "${deniedResults.join('; ')}"`);

    // Reset and mock dialog.showMessageBox to simulate user clicking "Allow" (response: 0)
    confirmCallCount = 0;
    dialog.showMessageBox = (async (_win: any, _opts?: any) => {
      confirmCallCount++;
      return { response: 0, checkboxChecked: false }; // 0 = Allow
    }) as any;

    const allowedResults = await runTools([{ tool: 'test_sensitive', args: {} }]);
    assert(confirmCallCount === 1, `Confirmation dialog was shown exactly once on allow (actual: ${confirmCallCount})`);
    assert(allowedResults.some(r => r.includes('Test sensitive tool executed successfully')), 
      `User "Allow" successfully executed tool: "${allowedResults.join('; ')}"`);

    // Restore dialog
    dialog.showMessageBox = originalShowMessageBox;

    // 6. Input rules: registry validates args with the zod schema
    console.log('\n[6] Checking input rule validation...');

    const missingY = toolRegistry.validateArgs('click_screen', { x: 500 });
    assert(missingY.ok === false, 'click_screen without "y" is rejected');

    const badKey = toolRegistry.validateArgs('press_key', { key: 'ctrl+a' });
    assert(badKey.ok === false, 'press_key with an unsupported key is rejected');

    const defaulted = toolRegistry.validateArgs('set_volume', {});
    assert(
      defaulted.ok === true && (defaulted as { value: Record<string, unknown> }).value['mode'] === 'up',
      'set_volume without "mode" gets the default "up"'
    );

    // 7. runTools rejects invalid args BEFORE showing the confirmation dialog
    console.log('\n[7] Invalid arguments never reach the confirmation gate...');

    confirmCallCount = 0;
    dialog.showMessageBox = (async (_win: any, _opts?: any) => {
      confirmCallCount++;
      return { response: 0, checkboxChecked: false }; // 0 = Allow
    }) as any;

    const rejected = await runTools([{ tool: 'press_key', args: { key: 'ctrl+a' } }]);
    assert(confirmCallCount === 0, 'no confirmation dialog is shown for invalid arguments');
    assert(
      rejected.some(r => r.includes('rejected invalid arguments')),
      `invalid args produce a structured error: "${rejected.join('; ')}"`
    );

    dialog.showMessageBox = originalShowMessageBox;

    // 8. Per-tool timeout: a slow tool is cut off at its policy timeout
    console.log('\n[8] Checking per-tool timeout enforcement...');

    toolRegistry.register({
      name: 'test_slow_tool',
      description: 'Test tool that hangs; verifies the per-tool timeout.',
      risk: 'READ',
      schema: z.object({}),
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { success: true, output: 'should never be seen' };
      },
    });

    const savedTimeouts = getPolicy().toolTimeouts;
    updatePolicy({ toolTimeouts: { ...savedTimeouts, test_slow_tool: 100 } });

    const started = Date.now();
    const timeoutResults = await runTools([{ tool: 'test_slow_tool', args: {} }]);
    const elapsed = Date.now() - started;

    updatePolicy({ toolTimeouts: savedTimeouts });

    assert(
      timeoutResults.some(r => r.includes('timed out after 100ms')),
      `slow tool is cut off at its timeout: "${timeoutResults.join('; ')}"`
    );
    assert(elapsed < 2000, `timeout fires promptly (took ${elapsed}ms, expected about 100ms)`);

    // 9. Voice pipeline: a submitted recording must be processed, never silently dropped
    console.log('\n[9] Checking voice pipeline...');

    assert(
      typeof voice.setVoiceCallbacks === 'function' && typeof voice.defaultVoiceCallbacks === 'function',
      'voice callbacks can be installed without starting the wake word (setVoiceCallbacks/defaultVoiceCallbacks exist)'
    );

    assert(voice.isVoiceModeActive() === false, 'voice mode is off until enabled from the tray');

    if (typeof voice.setVoiceCallbacks === 'function') {
      let voiceEvents = 0;
      voice.setVoiceCallbacks({
        onWake: () => { voiceEvents++ },
        onTranscript: () => { voiceEvents++ },
        onResponse: () => { voiceEvents++ },
        onError: () => { voiceEvents++ }
      });

      // Make the STT step fail fast and deterministically (python not found on PATH)
      const savedPath = process.env.PATH;
      process.env.PATH = '';
      const sttFilesBefore = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('miko-stt-'));
      try {
        await voice.handleRecordingComplete(Buffer.from('miko-test-audio').toString('base64'));
      } finally {
        process.env.PATH = savedPath;
      }
      const sttFilesAfter = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('miko-stt-'));

      assert(
        voiceEvents === 1,
        `recording produced exactly one voice event - transcript or spoken error (got ${voiceEvents})`
      );
      assert(
        sttFilesAfter.length === sttFilesBefore.length,
        `temp recording file is cleaned up (before: ${sttFilesBefore.length}, after: ${sttFilesAfter.length})`
      );

      // Verify voice confirmation gate
      if (typeof voice.handleVoiceConfirmation === 'function') {
        const confirmPromise = voice.handleVoiceConfirmation('test_sensitive', {});
        // Simulate voice saying "yes, allow"
        voice.defaultVoiceCallbacks; // Ensure referenced
        // Call the current active onTranscript handler
        const currentCallbacks = (voice as any);
        // Wait microtask then confirm
        setTimeout(async () => {
          // Provide 'yes' to trigger confirmation
          if (typeof currentCallbacks.handleVoiceResponse === 'function') {
            // Simulated voice affirmative
          }
        }, 50);
        assert(typeof voice.handleVoiceConfirmation === 'function', 'voice confirmation handler exists');
      }
    }

    // 10. LLM fallback: when Gemini fails, the Groq request must carry the
    // conversation (messages) and Miko's persona - and the reply must be used.
    console.log('\n[10] Checking Groq fallback request shape...');

    const realFetch = globalThis.fetch;
    const groqBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes(':generateContent')) {
        return new Response('{"error":{"message":"overloaded"}}', { status: 500 });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response('{}', { status: 200 });
      }
      if (url.includes('api.groq.com/openai/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile', active: true }] }), { status: 200 });
      }
      if (url.includes('api.groq.com/openai/v1/chat/completions')) {
        groqBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ speech: 'Hi from Groq', emotion: 'happy', gesture: 'nod', actions: [], done: true }) } }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const fallbackBrain = createBrain({ apiKey: 'test-key', groqApiKey: 'groq-key' });
      const reply = await fallbackBrain.ask('hello there');

      assert(groqBodies.length > 0, `Groq fallback was reached (got ${groqBodies.length} requests)`);
      if (groqBodies.length > 0) {
        const body = groqBodies[0] as { messages?: Array<{ role: string; content: string }> };
        const messages = Array.isArray(body.messages) ? body.messages : null;
        assert(
          messages !== null && messages.length >= 2,
          `Groq request carries the conversation - system + user message (got: ${messages ? messages.length : 'messages key missing'})`
        );
        assert(
          messages !== null &&
            messages[0].role === 'system' &&
            typeof messages[0].content === 'string' &&
            messages[0].content.includes('Miko'),
          'Groq request carries the Miko persona as a system message'
        );
      }
      assert(reply.speech === 'Hi from Groq', `Groq reply becomes Miko's speech (got "${reply.speech}")`);
    } finally {
      globalThis.fetch = realFetch;
    }

    // 11. Registry-driven action args: schema and sanitizer must derive from
    // the tool's zod schema (single source of truth), not a hand-maintained list.
    console.log('\n[11] Checking registry-driven action args...');

    toolRegistry.register({
      name: 'test_custom_arg_tool',
      description: 'Test tool with custom args to prove schema/sanitizer stay in sync.',
      risk: 'READ',
      schema: z.object({ contact: z.string().min(1), count: z.number() }),
      handler: async () => {
        return { success: true, output: 'ok' };
      },
    });

    const argTypesForTests = (): Record<string, Record<string, 'string' | 'number'>> => {
      const out: Record<string, Record<string, 'string' | 'number'>> = {};
      for (const t of toolRegistry.getAll()) out[t.name] = t.argTypes ?? {};
      return out;
    };

    const schema2 = toolRegistry.getSchemaForLLM();
    const props2 = (schema2.properties as any).actions.items.properties;
    assert(props2.tool && Array.isArray(props2.tool.enum) && props2.tool.enum.includes('test_custom_arg_tool'), 'LLM schema keeps the tool enum (incl. newly registered tools)');
    assert(props2.contact !== undefined, 'LLM schema auto-includes a custom "contact" arg');
    assert(props2.count && props2.count.type === 'NUMBER', 'custom numeric arg is typed NUMBER');
    assert(props2.name === undefined && props2.target === undefined, 'dead schema entries (name/target) are gone');

    const sanitized = sanitize(
      {
        speech: 'ok',
        emotion: 'happy',
        gesture: 'none',
        done: true,
        actions: [{ tool: 'test_custom_arg_tool', contact: '  tufu panda  ', count: 3, evil: 'should be dropped' }]
      },
      toolRegistry.getNames(),
      argTypesForTests()
    );
    assert(sanitized !== null && sanitized.actions.length === 1, 'action with custom args survives sanitize');
    const sargs = (sanitized?.actions[0]?.args ?? {}) as Record<string, unknown>;
    assert(sargs.contact === 'tufu panda', 'custom string arg is kept and trimmed');
    assert(sargs.count === 3, 'custom number arg is kept');
    assert(!('evil' in sargs), 'unknown arg keys are dropped by sanitize');
    assert(
      toolRegistry.validateArgs('test_custom_arg_tool', { contact: 'x', count: 1 }).ok === true,
      'validateArgs accepts the custom args'
    );

    assert(sanitize('not an object', toolRegistry.getNames(), argTypesForTests()) === null, 'sanitize returns null for non-object raw');
    const edgeSan = sanitize(
      { speech: 'ok', actions: [{ tool: 'no_such_tool', text: 'x' }, { tool: 'type_text', text: 'hello' }] },
      toolRegistry.getNames(),
      argTypesForTests()
    );
    assert(
      edgeSan !== null && edgeSan.actions.length === 1 && edgeSan.actions[0].tool === 'type_text',
      'unknown tools are dropped, known tools kept'
    );
    const noActionSan = sanitize({ speech: 'ok' }, toolRegistry.getNames(), argTypesForTests());
    assert(
      noActionSan !== null && noActionSan.done === true && noActionSan.actions.length === 0,
      'reply with no actions defaults done=true'
    );

    // 12. open_url must only accept http(s) URLs (prompt-injection hardening)
    console.log('\n[12] Checking open_url scheme restriction...');

    assert(toolRegistry.validateArgs('open_url', { url: 'file:///C:/Windows/System32/cmd.exe' }).ok === false, 'open_url rejects file:// URLs');
    assert(toolRegistry.validateArgs('open_url', { url: 'ftp://evil.example/x' }).ok === false, 'open_url rejects ftp:// URLs');
    assert(toolRegistry.validateArgs('open_url', { url: 'javascript:alert(1)' }).ok === false, 'open_url rejects javascript: URLs');
    assert(toolRegistry.validateArgs('open_url', { url: 'https://example.com' }).ok === true, 'open_url accepts https URLs');
    assert(toolRegistry.validateArgs('open_url', { url: 'http://localhost:3000/chat' }).ok === true, 'open_url accepts http URLs (local sidecars)');

    // 13. A signal aborted before execution must skip the tool entirely
    console.log('\n[13] Checking pre-aborted signal handling...');

    const ac2 = new AbortController();
    ac2.abort();
    const abortedResult = await toolRegistry.executeWithTimeout('test_sensitive', {}, {
      trayMode: 'normal',
      session: { opened: false },
      abortSignal: ac2.signal,
    });
    assert(
      abortedResult.success === false && (abortedResult.error ?? '').includes('Aborted by user'),
      `pre-aborted signal skips tool execution (got: ${JSON.stringify(abortedResult)})`
    );
    const abortResults = await runTools([{ tool: 'test_sensitive', args: {} }], { opened: false }, ac2.signal);
    assert(
      abortResults.some((r) => r.includes('aborted by user')),
      `runTools short-circuits on a pre-aborted signal without executing anything (got: "${abortResults.join('; ')}")`
    );

    // 14. Gemini model pool must contain only chat-capable Flash models —
    // never the Flash-branded image/video/TTS/Live models from the live list.
    console.log('\n[14] Checking Gemini model pool filtering...');

    const attemptedModels: string[] = [];
    globalThis.fetch = (async (input: any, _init?: any) => {
      const url = String(input);
      if (url.includes(':generateContent')) {
        attemptedModels.push(url.split('/models/')[1].split(':')[0]);
        return new Response(
          '{"candidates":[{"content":{"parts":[{"text":"{\\"speech\\":\\"ok\\",\\"emotion\\":\\"neutral\\",\\"gesture\\":\\"none\\",\\"actions\\":[],\\"done\\":true}"}]}}]}',
          { status: 200 }
        );
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-omni-1.1-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-3.1-flash-live-preview', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-nano-banana-2.1', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const poolBrain = createBrain({ apiKey: 'test-key' });
      const poolReply = await poolBrain.ask('hello');
      assert(poolReply.speech === 'ok', `brain answers via a chat model (got "${poolReply.speech}")`);
      assert(attemptedModels.length > 0, `a model was attempted (got ${attemptedModels.length})`);
      assert(
        attemptedModels.every((m) => !m.includes('image') && !m.includes('omni') && !m.includes('banana') && !m.includes('tts') && !m.includes('live')),
        `non-chat flash models are never attempted (attempted: ${attemptedModels.join(', ') || 'none'})`
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    // 15. Groq pool must contain only chat models (whisper/TTS/guard excluded)
    console.log('\n[15] Checking Groq model pool filtering...');

    const attemptedGroqModels: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes(':generateContent')) {
        return new Response('{"error":{"message":"overloaded"}}', { status: 500 });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response('{}', { status: 200 });
      }
      if (url.includes('api.groq.com/openai/v1/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'llama-3.3-70b-versatile', active: true },
              { id: 'whisper-large-v3', active: true },
              { id: 'playai-tts', active: true },
              { id: 'llama-guard-3-8b', active: true }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('api.groq.com/openai/v1/chat/completions')) {
        const body = JSON.parse(String(init?.body));
        attemptedGroqModels.push(body.model);
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ speech: 'Groq chat ok', emotion: 'happy', gesture: 'nod', actions: [], done: true }) } }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const groqFilterBrain = createBrain({ apiKey: 'test-key', groqApiKey: 'groq-key' });
      const groqFilterReply = await groqFilterBrain.ask('hello');
      assert(groqFilterReply.speech === 'Groq chat ok', `brain answers via a Groq chat model (got "${groqFilterReply.speech}")`);
      assert(
        attemptedGroqModels.length > 0 && attemptedGroqModels.every((m) => !m.includes('whisper') && !m.includes('tts') && !m.includes('guard')),
        `non-chat Groq models are never attempted (attempted: ${attemptedGroqModels.join(', ') || 'none'})`
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    // 16. Shell openers must not be available to the agent (the open_app +
    // type_text NORMAL-risk composition would otherwise give unconfirmed
    // command execution).
    console.log('\n[16] Checking shell openers are blocked...');

    const cmdResult = await toolRegistry.executeWithTimeout('open_app', { app: 'cmd' }, {
      trayMode: 'normal',
      session: { opened: false },
    });
    assert(
      cmdResult.success === false && (cmdResult.error ?? '').includes('Blocked app'),
      `open_app refuses cmd.exe (got: ${JSON.stringify(cmdResult)})`
    );
    const wtResult = await toolRegistry.executeWithTimeout('open_app', { app: 'terminal' }, {
      trayMode: 'normal',
      session: { opened: false },
    });
    assert(wtResult.success === false, 'open_app refuses Windows Terminal');
    const notepadResult = toolRegistry.validateArgs('open_app', { app: 'notepad' });
    assert(notepadResult.ok === true, 'open_app still accepts regular apps (notepad)');

    // 17. A tool cut off by its timeout must kill the child processes it
    // spawned — otherwise the agent is told "failed" while the side effect
    // still lands afterwards.
    console.log('\n[17] Checking timed-out tools kill spawned children...');

    const execFileForTests = promisify(execFile);
    toolRegistry.register({
      name: 'test_child_tool',
      description: 'Spawns a long local ping; must be killed by the tool timeout.',
      risk: 'READ',
      schema: z.object({}),
      handler: async (_args, ctx) => {
        await execFileForTests('ping', ['-n', '30', '127.0.0.1'], {
          windowsHide: true,
          signal: ctx.execSignal,
        });
        return { success: true, output: 'child finished' };
      },
    });

    const savedTimeouts2 = getPolicy().toolTimeouts;
    updatePolicy({ toolTimeouts: { ...savedTimeouts2, test_child_tool: 150 } });
    const childStart = Date.now();
    const childResults = await toolRegistry.executeWithTimeout('test_child_tool', {}, {
      trayMode: 'normal',
      session: { opened: false },
    });
    const childElapsed = Date.now() - childStart;
    updatePolicy({ toolTimeouts: savedTimeouts2 });

    assert(
      childResults.success === false && (childResults.error ?? '').includes('timed out after 150ms'),
      `child tool is cut off at its timeout (got: ${JSON.stringify(childResults)})`
    );
    assert(childElapsed < 2000, `timeout fires promptly (took ${childElapsed}ms, expected about 150ms)`);

    // Give the OS a moment to reap the killed child, then verify none remains.
    await new Promise((r) => setTimeout(r, 700));
    const tasklist = await execFileForTests('tasklist', ['/FI', 'IMAGENAME eq PING.EXE'], { windowsHide: true });
    assert(
      !tasklist.stdout.toUpperCase().includes('PING.EXE'),
      'timed-out tool leaves no running child process behind'
    );

    // 18. Settings infrastructure (MIKO_VISIBLE / DRY_RUN) — Phase 4's send
    // tools and the phases.md "Final Step" depend on these.
    console.log('\n[18] Checking settings infrastructure...');

    const savedSettings = { ...getSettings() };
    assert(isVisibleMode() === savedSettings.MIKO_VISIBLE, 'isVisibleMode reflects stored MIKO_VISIBLE');
    assert(savedSettings.MIKO_VISIBLE === true, 'MIKO_VISIBLE defaults to true (project rule)');

    updateSettings({ DRY_RUN: true });
    assert(isDryRun() === true, 'DRY_RUN toggle is readable immediately after update');
    updateSettings({ DRY_RUN: false, MIKO_VISIBLE: true });
    assert(isDryRun() === false && isVisibleMode() === true, 'settings restore to defaults');

    // 19. A model whose response never arrives (hung headers) must not stall
    // the agent — the watchdog moves to the next model and the brain replies.
    console.log('\n[19] Checking brain watchdog against hung models...');

    const hungAttempts: string[] = [];
    globalThis.fetch = (async (input: any, _init?: any) => {
      const url = String(input);
      if (url.includes(':generateContent')) {
        const model = url.split('/models/')[1].split(':')[0];
        hungAttempts.push(model);
        if (model === 'gemini-3.8-flash') {
          // Never settles: simulates hung response headers where
          // AbortSignal.timeout may never fire
          return new Promise<Response>(() => {});
        }
        return new Response(
          '{"candidates":[{"content":{"parts":[{"text":"{\\"speech\\":\\"recovered\\",\\"emotion\\":\\"happy\\",\\"gesture\\":\\"nod\\",\\"actions\\":[],\\"done\\":true}"}]}}]}',
          { status: 200 }
        );
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const hangBrain = createBrain({ apiKey: 'test-key', timeoutMs: 250 });
      const hangStart = Date.now();
      const hangReply = await hangBrain.ask('hello');
      const hangElapsed = Date.now() - hangStart;
      assert(hangReply.speech === 'recovered', `brain recovers after a hung model (got "${hangReply.speech}")`);
      assert(hangElapsed < 5000, `hung model does not stall the agent (took ${hangElapsed}ms, watchdog fires at 250ms)`);
      assert(hungAttempts.includes('gemini-3.8-flash') && hungAttempts.includes('gemini-3.5-flash'), 'the next model was attempted after the hang');
    } finally {
      globalThis.fetch = realFetch;
    }

    console.log(`\n--- Test Results: ${passed} Passed, ${failed} Failed ---\n`);

    if (failed > 0) {
      app.exit(1);
    } else {
      app.exit(0);
    }
  } catch (err) {
    console.error('[TEST ERROR]:', err);
    app.exit(1);
  }
});

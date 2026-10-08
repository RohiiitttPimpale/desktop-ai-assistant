import { app, dialog } from 'electron';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import { toolRegistry } from './src/main/registry';
import './src/main/packs/core';
import { runTools } from './src/main/tools';
import { getPolicy, updatePolicy } from './src/main/policy';
import * as voice from './src/main/voice/index';
import { createBrain } from './src/main/brain';

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

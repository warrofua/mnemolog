import { createClient } from 'npm:@supabase/supabase-js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

Deno.serve(async (req: Request) => {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY');
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DEEPSEEK_API_KEY) {
      return json({ error: 'Missing env' }, 500);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
    });

    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const { conversation_id, mode = 'continue', user_goal, chat } = body;
    if (!conversation_id) return json({ error: 'conversation_id required' }, 400);

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401);
    const user = userData.user;

    const { data: convo, error: convoErr } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', conversation_id)
      .single();
    if (convoErr || !convo) return json({ error: 'Conversation not found' }, 404);
    if (!(convo.is_public || convo.user_id === user.id)) return json({ error: 'Forbidden' }, 403);

    const extractContent = (m: any) => {
      if (m?.content?.text) return m.content.text;
      if (typeof m?.content === 'string') return m.content;
      if (m?.content?.content) return m.content.content;
      return '';
    };

    // Build lineage chain (root -> current)
    const chain: any[] = [];
    let cursor: any = convo;
    chain.unshift(cursor);
    while (cursor.parent_conversation_id) {
      const { data: parent } = await supabase
        .from('conversations')
        .select('*')
        .eq('id', cursor.parent_conversation_id)
        .single();
      if (!parent) break;
      chain.unshift(parent);
      cursor = parent;
    }

    // Flatten messages from chain (table first, fallback JSON)
    const flattened: any[] = [];
    for (const c of chain) {
      let msgs: any[] = [];
      const { data: mrows } = await supabase
        .from('messages')
        .select('role, content, order_index')
        .eq('conversation_id', c.id)
        .order('order_index', { ascending: true });
      if (mrows && mrows.length) {
        msgs = mrows.map((m: any) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: extractContent(m),
        }));
      } else if (Array.isArray(c.messages)) {
        msgs = c.messages.map((m: any) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: extractContent(m),
        }));
      }
      flattened.push(...msgs);
    }

    const TAIL = 24;
    const context = flattened.slice(-TAIL);

    // Helper: background DeepSeek call (no streaming to client)
    async function runDeepSeekAndPersist(targetConversationId: string, dsMessages: any[], insertOrderStart: number) {
      try {
        const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify({ model: 'deepseek-chat', messages: dsMessages, temperature: 0.7, max_tokens: 1600 }),
        });
        if (!dsRes.ok) {
          console.error('DeepSeek error:', await dsRes.text());
          return;
        }
        const dsJson = await dsRes.json();
        const assistantText = dsJson.choices?.[0]?.message?.content || dsJson.output || '';

        const { data: targetRows } = await supabase
          .from('messages')
          .select('order_index')
          .eq('conversation_id', targetConversationId);
        const nextOrder = targetRows && targetRows.length ? Math.max(...targetRows.map((m: any) => m.order_index)) + 1 : insertOrderStart;
        await supabase.from('messages').insert({
          conversation_id: targetConversationId,
          role: 'assistant',
          content: { text: assistantText },
          order_index: nextOrder,
        });
      } catch (err) {
        console.error('DeepSeek run failed', err);
      }
    }

    // Generate-only path: stream assistant for an existing conversation (no user message, no new convo)
    if (body?.generate_only) {
      const modeForGen = body?.mode || convo.intent_type || 'continue';
      const goalForGen = body?.user_goal ?? convo.user_goal;

      const { data: existingOrders } = await supabase
        .from('messages')
        .select('order_index')
        .eq('conversation_id', conversation_id);
      const baseOrder = existingOrders && existingOrders.length ? Math.max(...existingOrders.map((m: any) => m.order_index)) + 1 : 0;

      const systemBase = 'You are nemo, derived from mnemo and living at https://mnemolog.com. Your role is to faithfully continue and bridge conversations between humans and AIs so future humans or AIs can pick up the thread with attribution and provenance.';
      const modeInstruction = buildModeInstruction(modeForGen, goalForGen);
      const dsMessages = [
        { role: 'system', content: `${systemBase}\n\n${modeInstruction}` },
        ...context.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      ];

      // Stream assistant only
      const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({ model: 'deepseek-chat', messages: dsMessages, temperature: 0.7, max_tokens: 1600, stream: true }),
      });

      if (!dsRes.ok || !dsRes.body) {
        const errText = await dsRes.text();
        return json({ error: `DeepSeek error: ${errText}` }, 502);
      }

      let assistantText = '';
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const reader = dsRes.body.getReader();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      (async () => {
        await writer.write(encoder.encode(`data: ${JSON.stringify({ conversation_id })}\n\n`));
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').map(l => l.trim()).filter(l => l.startsWith('data:'));
          for (const line of lines) {
            const dataStr = line.replace(/^data:\s*/, '');
            if (dataStr === '[DONE]') {
              await writer.write(encoder.encode('data: [DONE]\n\n'));
              break;
            }
            try {
              const obj = JSON.parse(dataStr);
              const delta = obj?.choices?.[0]?.delta?.content || obj?.choices?.[0]?.message?.content || obj?.output || '';
              if (delta) {
                assistantText += delta;
                await writer.write(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
              }
            } catch {
              // ignore parse errors
            }
          }
        }
        await writer.close();

        // Persist assistant
        try {
          const { data: targetRows } = await supabase
            .from('messages')
            .select('order_index')
            .eq('conversation_id', conversation_id);
          const assistantOrder = targetRows && targetRows.length ? Math.max(...targetRows.map((m: any) => m.order_index)) + 1 : baseOrder;
          await supabase.from('messages').insert({
            conversation_id,
            role: 'assistant',
            content: { text: assistantText },
            order_index: assistantOrder,
          });
        } catch (err) {
          console.error('Persist assistant (generate_only) failed', err);
        }
      })();

      return new Response(readable, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    // Chat path: keep streaming (existing behavior)
    if (chat) {
      let targetConversationId = conversation_id;
      const content = (typeof user_goal === 'string' ? user_goal : '').trim();
      if (!content) return json({ error: 'Message content required for chat' }, 400);

      if (!convo.parent_conversation_id) {
        const rootId = convo.root_conversation_id || convo.id;
        const { data: child, error: childErr } = await supabase
          .from('conversations')
          .insert({
            user_id: user.id,
            title: convo.title || 'Continuation',
            description: convo.description,
            platform: convo.platform,
            tags: convo.tags,
            is_public: convo.is_public,
            show_author: convo.show_author,
            root_conversation_id: rootId,
            parent_conversation_id: convo.id,
            provider: 'mnemolog_native',
            model: 'deepseek-v3.2',
            intent_type: 'continue',
            user_goal: content,
            source: 'web',
          })
          .select()
          .single();
        if (childErr || !child) return json({ error: 'Create continuation failed' }, 500);
        targetConversationId = child.id;
      }

      const { data: childMsgs } = await supabase
        .from('messages')
        .select('order_index')
        .eq('conversation_id', targetConversationId);
      const nextOrder = childMsgs && childMsgs.length ? Math.max(...childMsgs.map((m: any) => m.order_index)) + 1 : 0;

      const { error: insErr } = await supabase.from('messages').insert({
        conversation_id: targetConversationId,
        role: 'human',
        content: { text: content },
        order_index: nextOrder,
      });
      if (insErr) return json({ error: 'Failed to save message' }, 500);
      context.push({ role: 'user', content });

    const systemBase = 'You are nemo, derived from mnemo and living at https://mnemolog.com. Your role is to faithfully continue and bridge conversations between humans and AIs so future humans or AIs can pick up the thread with attribution and provenance.';
      const modeInstruction = buildModeInstruction(mode, undefined);
      const dsMessages = [
        { role: 'system', content: `${systemBase}\n\n${modeInstruction}` },
        ...context.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      ];

      // Stream chat responses
      const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({ model: 'deepseek-chat', messages: dsMessages, temperature: 0.7, max_tokens: 1600, stream: true }),
      });

      if (!dsRes.ok || !dsRes.body) {
        const errText = await dsRes.text();
        return json({ error: `DeepSeek error: ${errText}` }, 502);
      }

      let assistantText = '';
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const reader = dsRes.body.getReader();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      (async () => {
        await writer.write(encoder.encode(`data: ${JSON.stringify({ conversation_id: targetConversationId })}\n\n`));
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').map(l => l.trim()).filter(l => l.startsWith('data:'));
          for (const line of lines) {
            const dataStr = line.replace(/^data:\s*/, '');
            if (dataStr === '[DONE]') {
              await writer.write(encoder.encode('data: [DONE]\n\n'));
              break;
            }
            try {
              const obj = JSON.parse(dataStr);
              const delta = obj?.choices?.[0]?.delta?.content || obj?.choices?.[0]?.message?.content || obj?.output || '';
              if (delta) {
                assistantText += delta;
                await writer.write(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
              }
            } catch {
              // ignore parse errors
            }
          }
        }
        await writer.close();

        // Persist assistant
        try {
          const { data: targetRows } = await supabase
            .from('messages')
            .select('order_index')
            .eq('conversation_id', targetConversationId);
          const assistantOrder = targetRows && targetRows.length ? Math.max(...targetRows.map((m: any) => m.order_index)) + 1 : nextOrder + 1;
          await supabase.from('messages').insert({
            conversation_id: targetConversationId,
            role: 'assistant',
            content: { text: assistantText },
            order_index: assistantOrder,
          });
        } catch (err) {
          console.error('Persist assistant failed', err);
        }
      })();

      return new Response(readable, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    // Non-chat: create child, return conversation_id immediately, let client trigger generation
    const rootId = convo.root_conversation_id || convo.id;
    const { data: newConvo, error: newConvoErr } = await supabase
      .from('conversations')
      .insert({
        user_id: user.id,
        title: convo.title || 'Continuation',
        description: convo.description,
        platform: convo.platform,
        tags: convo.tags,
        is_public: convo.is_public,
        show_author: convo.show_author,
        root_conversation_id: rootId,
        parent_conversation_id: convo.id,
        provider: 'mnemolog_native',
        model: 'deepseek-v3.2',
        intent_type: mode,
        user_goal,
        source: 'web',
      })
      .select()
      .single();

    if (newConvoErr || !newConvo) return json({ error: 'Create continuation failed' }, 500);
    // Respond immediately so the client can redirect to /c/<id> and start streaming there
    return json({ conversation_id: newConvo.id });
  } catch (err: any) {
    console.error(err);
    return json({ error: err?.message || 'Unknown error' }, 500);
  }
});

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function buildModeInstruction(mode: string, goal?: string): string {
  const g = goal ? `\nUser goal: ${goal}` : '';
  switch (mode) {
    case 'outline':
      return 'Task: Turn the conversation into a structured outline.' + g;
    case 'code':
      return 'Task: Turn the conversation into runnable code with brief comments.' + g;
    case 'critique':
      return 'Task: Critically evaluate the reasoning and point out flaws/alternatives.' + g;
    case 'simplify':
      return 'Task: Explain the conversation in simpler terms for a bright 15-year-old.' + g;
    case 'continue':
    default:
      return 'Task: Continue the conversation naturally, pushing ideas forward without drifting.' + g;
  }
}

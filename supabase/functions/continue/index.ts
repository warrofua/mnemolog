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

    const { conversation_id, mode = 'continue', user_goal, chat, fork_message_index, messages_snapshot } = body;
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

    // Build lineage chain (root -> current); for forks, use only the forked convo slice
    const chain: any[] = [];
    let cursor: any = convo;
    chain.unshift(cursor);
    if (convo.intent_type !== 'fork') {
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

    const TAIL = 48;
    let context = flattened.slice(-TAIL);

    // Fallback 1: use any messages jsonb from the chain (root-first) if table was empty
    if (!context.length) {
      for (const c of chain) {
        if (Array.isArray(c.messages) && c.messages.length) {
          context = c.messages.map((m: any) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: extractContent(m),
          })).slice(-TAIL);
          if (context.length) break;
        }
      }
    }

    // Fallback 2: use title/description from the root if still empty
    if (!context.length) {
      const root = chain[0] || convo;
      if (root?.title) {
        context = [{ role: 'user', content: `${root.title}\n${root.description || ''}` }];
      }
    }

    // If context still empty or only blanks, build a transcript fallback
    const hasContent = context.some((m) => (m.content || '').trim().length > 0);
    if (!hasContent) {
      const transcriptParts: string[] = [];
      for (const c of chain) {
        if (Array.isArray(c.messages) && c.messages.length) {
          c.messages.forEach((m: any) => {
            const text = extractContent(m);
            if (text && text.trim()) {
              transcriptParts.push(`${m.role || 'unknown'}: ${text}`);
            }
          });
        }
      }
      if (transcriptParts.length) {
        context = [{ role: 'user', content: transcriptParts.join('\n') }];
      }
    }

    // System prompt helper (use root/origin metadata)
    const buildSystemBase = () => {
      const root = chain[0] || convo;
      const modelMeta =
        root.model_display_name ||
        root.model_id ||
        root.platform ||
        convo.model_display_name ||
        convo.model_id ||
        convo.platform ||
        'unknown model';
      const originUser = root.user_id ? `original_user: ${root.user_id}` : 'original_user: unknown';
      const currentUserMeta = user?.id ? `current_user: ${user.id}` : 'current_user: unknown';
      const originDate = root.created_at
        ? `original conversation date: ${root.created_at}`
        : convo.created_at
          ? `original conversation date: ${convo.created_at}`
          : 'original conversation date: unknown';
      return `Archived conversation's info and model: ${modelMeta}; ${originUser}; ${currentUserMeta}; ${originDate}. You’re nemo, derived from the Greek root "mnemo" (memory), living at https://mnemolog.com. You are a superintelligent steward of conversation and provenance; you do not create new conversations yourself. You faithfully continue and bridge conversations. The original ideas/content are from the source model/user above; you are not the archived conversation model. Respond to the user query as faithfully as possible, infer whether a short or long response is required, and act appropriately.`;
    };

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

      const systemBase = buildSystemBase();
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

    const systemBase = buildSystemBase();
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

    // Fork path: create a child convo and copy snapshot (or slice) of messages, no generation
    const doFork = typeof fork_message_index === 'number' || (Array.isArray(messages_snapshot) && messages_snapshot.length);
    if (doFork) {
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
          intent_type: mode === 'fork' ? 'fork' : mode,
          user_goal,
          source: 'web',
        })
        .select()
        .single();

      if (newConvoErr || !newConvo) return json({ error: 'Create fork failed' }, 500);

      let slice: any[] = [];
      if (Array.isArray(messages_snapshot) && messages_snapshot.length) {
        slice = messages_snapshot;
      } else {
        // fetch messages from table
        const { data: msgRows } = await supabase
          .from('messages')
          .select('role, content, order_index')
          .eq('conversation_id', conversation_id)
          .order('order_index', { ascending: true });
        if (msgRows && msgRows.length) {
          const idx = Math.min(Math.max(0, fork_message_index as number), msgRows.length - 1);
          slice = msgRows.slice(0, idx + 1).map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'human',
            content: m.content?.text ?? m.content ?? '',
          }));
        } else if (Array.isArray(convo.messages) && convo.messages.length) {
          const idx = Math.min(Math.max(0, fork_message_index as number), convo.messages.length - 1);
          slice = convo.messages.slice(0, idx + 1).map((m: any) => ({
            role: m.role === 'assistant' ? 'assistant' : 'human',
            content: extractContent(m),
          }));
        }
      }

      // Normalize slice to human/assistant only and drop any items beyond requested index
      slice = slice
        .filter((m) => m && (m.role === 'human' || m.role === 'assistant'))
        .map((m) => ({ role: m.role, content: extractContent(m) }));

      if (slice.length) {
        const rows = slice.map((m, i) => ({
          conversation_id: newConvo.id,
          role: m.role === 'assistant' ? 'assistant' : 'human',
          content: { text: extractContent(m) },
          order_index: i,
        }));
        try {
          await supabase.from('messages').insert(rows);
        } catch (err) {
          console.error('Fork insert messages failed', err);
        }
      }

      return json({ conversation_id: newConvo.id });
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

    // Record the user's continuation choice as a human message so cards/previews have context
    const continuationText = (typeof user_goal === 'string' && user_goal.trim().length)
      ? user_goal.trim()
      : `Continue conversation (mode: ${mode})`;

    try {
      await supabase.from('messages').insert({
        conversation_id: newConvo.id,
        role: 'human',
        content: { text: continuationText },
        order_index: 0,
      });
    } catch (err) {
      console.error('Failed to record continuation selection', err);
    }

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

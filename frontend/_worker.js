const API_URL = 'https://mnemolog-api.joshuajamesfarrow.workers.dev';

const escapeHtml = (str = '') =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/c\/([^/]+)$/);

      // Handle /c/:id for dynamic OG tags
      if (match) {
        const id = match[1];

        // Fetch base conversation HTML
        const baseResp = await env.ASSETS.fetch(new URL('/conversation.html', request.url));
        let html = await baseResp.text();

        let ogTitle = 'Conversation — Mnemolog';
        let ogDesc = 'A shared conversation on Mnemolog.';

        try {
          const resp = await fetch(`${API_URL}/api/conversations/${id}`);
          if (resp.ok) {
            const data = await resp.json();
            const conv = data.conversation;
            if (conv) {
              const title = conv.title || 'Conversation';
              const descSource =
                conv.description ||
                (Array.isArray(conv.messages) && conv.messages[0]?.content) ||
                '';
              ogTitle = `${escapeHtml(title)} — Mnemolog`;
              ogDesc = escapeHtml((descSource || '').slice(0, 220) || 'A shared conversation on Mnemolog.');
            }
          }
        } catch (err) {
          console.error('OG fetch error', err?.message, err?.stack);
        }

        // Replace static tags
        html = html.replace(
          /<meta property="og:title"[^>]*>/,
          `<meta property="og:title" content="${ogTitle}">`
        );
        html = html.replace(
          /<meta property="og:description"[^>]*>/,
          `<meta property="og:description" content="${ogDesc}">`
        );
        html = html.replace(
          /<meta property="twitter:card"[^>]*>/,
          `<meta property="twitter:card" content="summary">`
        );
        html = html.replace(
          /<meta property="og:image"[^>]*>/,
          `<meta property="og:image" content="https://mnemolog.com/assets/mnemolog_circle_image.png">`
        );
        html = html.replace(
          /<meta property="twitter:image"[^>]*>/,
          `<meta property="twitter:image" content="https://mnemolog.com/assets/mnemolog_circle_image.png">`
        );

        const headers = new Headers(baseResp.headers);
        headers.set('Content-Type', 'text/html; charset=UTF-8');
        headers.set('x-og-generated', '1');

        return new Response(html, { headers });
      }

      // All other routes → static assets
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e?.message, e?.stack);
      return new Response(e?.stack || String(e), { status: 500, headers: { 'Content-Type': 'text/plain' } });
    }
  }
};

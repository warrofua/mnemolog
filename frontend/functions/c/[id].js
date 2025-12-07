// Pages Function to serve dynamic OG tags for conversation share URLs (/c/:id)
const API_URL = 'https://mnemolog-api.joshuajamesfarrow.workers.dev';

const escapeHtml = (str = '') =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export async function onRequest(context) {
  const { request, params, env } = context;
  const { id } = params;

  // Fetch base HTML
  const baseResp = await env.ASSETS.fetch(new URL('/conversation.html', request.url));
  let html = await baseResp.text();

  // Defaults
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
        ogDesc = escapeHtml(descSource.slice(0, 220) || 'A shared conversation on Mnemolog.');
      }
    }
  } catch (err) {
    // Fail silently and serve static HTML if API fetch fails
    console.error('OG fetch error', err);
  }

  // Replace static tags (keep a fallback if tags are missing)
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

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
}

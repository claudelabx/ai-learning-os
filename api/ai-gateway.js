// ============================================================================
// AI Gateway — Serverless Function (Vercel)
// طبق سند 008 (AI Integration Architecture) و بند 128-129 سند چشم‌انداز بلندمدت:
// «هیچ بخشی از سیستم نباید مستقیماً به یک Provider وابسته باشد؛ تمام ارتباط‌ها
// فقط از طریق AI Gateway انجام می‌شود.»
//
// این تابع فقط وقتی درخواستی بیاد اجرا می‌شه (بدون سرور همیشه‌روشن) —
// دقیقاً همون معنی Serverless Function.
//
// وظیفه فعلی (فاز اول): دریافت Context از Frontend، ساخت Prompt، فراخوانی
// Provider انتخابی (Claude یا OpenAI)، و برگردوندن پاسخ یکدست.
// ============================================================================

// ---- تنظیمات از Environment Variables (هرگز در کد یا مرورگر هارد-کد نمی‌شن) ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const DEFAULT_PROVIDER = process.env.AI_DEFAULT_PROVIDER || 'gemini'; // 'gemini' | 'claude' | 'openai' — gemini پیش‌فرض چون رایگانه (بدون کارت بانکی)
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || ''; // محافظت ساده در برابر استفاده ناخواسته/عمومی

// ---- Prompt Orchestrator ساده (طبق بند 132 سند چشم‌انداز) ----
// System → Project → Task → Retrieved Knowledge (Notes) → درخواست نهایی
function buildPrompt(context) {
  const { project, task, recentNotes } = context || {};

  const systemPrompt =
    'تو یک دستیار برنامه‌ریزی و یادگیری هستی که داخل اپلیکیشن «AI Learning OS» به کاربر کمک می‌کنی. ' +
    'بر اساس اطلاعات پروژه/تسک زیر، فقط یک «گام بعدی» مشخص، عملی و کوتاه (حداکثر ۴-۵ جمله) پیشنهاد بده. ' +
    'از کلی‌گویی پرهیز کن؛ پیشنهاد باید مستقیماً قابل انجام باشد. پاسخ را به فارسی بده.';

  const lines = [];
  if (project) {
    lines.push(`## پروژه`);
    lines.push(`عنوان: ${project.title || '-'}`);
    if (project.description) lines.push(`توضیح: ${project.description}`);
    lines.push(`وضعیت: ${project.status || '-'}`);
  }
  if (task) {
    lines.push(`\n## تسک فعلی`);
    lines.push(`عنوان: ${task.title || '-'}`);
    if (task.description) lines.push(`توضیح: ${task.description}`);
    lines.push(`وضعیت: ${task.status || '-'} | اولویت: ${task.priority || '-'}`);
    if (task.due_date) lines.push(`ددلاین: ${task.due_date}`);
  }
  if (Array.isArray(recentNotes) && recentNotes.length) {
    lines.push(`\n## یادداشت‌های مرتبط اخیر`);
    recentNotes.slice(0, 5).forEach((n) => {
      lines.push(`- ${n.title}${n.description ? ': ' + n.description : ''}`);
    });
  }
  lines.push(`\n## درخواست`);
  lines.push('با توجه به موارد بالا، گام بعدی پیشنهادی‌ات چیست؟');

  return { systemPrompt, userPrompt: lines.join('\n') };
}

// ---- فراخوانی Gemini (Google AI Studio — رایگان، بدون کارت بانکی) ----
async function callGemini(systemPrompt, userPrompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY تنظیم نشده است.');
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      }),
    }
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error((data && data.error && data.error.message) || 'خطای Gemini API');
  const text = ((data.candidates || [])[0]?.content?.parts || []).map((p) => p.text || '').join('\n').trim();
  return text;
}

// ---- فراخوانی Claude (Anthropic Messages API) ----
async function callClaude(systemPrompt, userPrompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY تنظیم نشده است.');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error((data && data.error && data.error.message) || 'خطای Claude API');
  const text = (data.content || []).map((b) => b.text || '').join('\n').trim();
  return text;
}

// ---- فراخوانی OpenAI (Chat Completions API) ----
async function callOpenAI(systemPrompt, userPrompt) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY تنظیم نشده است.');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error((data && data.error && data.error.message) || 'خطای OpenAI API');
  const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
  return text;
}

// ---- Fallback خودکار: اگر Provider اول شکست خورد، بعدی رو امتحان کن (بند 128) ----
async function callWithFallback(preferredProvider, systemPrompt, userPrompt) {
  const allOrders = {
    gemini: ['gemini', 'claude', 'openai'],
    claude: ['claude', 'gemini', 'openai'],
    openai: ['openai', 'gemini', 'claude'],
  };
  const order = allOrders[preferredProvider] || allOrders.gemini;
  const callers = { gemini: callGemini, claude: callClaude, openai: callOpenAI };
  let lastError = null;
  for (const provider of order) {
    try {
      const text = await callers[provider](systemPrompt, userPrompt);
      return { text, provider };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('هیچ Providerای در دسترس نبود.');
}

module.exports = async function handler(req, res) {
  // ---- CORS ساده (اجازه فراخوانی از دامنه استاتیک همین پروژه) ----
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Gateway-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'فقط POST مجاز است.' } });
  }

  // ---- محافظت ساده در برابر استفاده عمومی/ناخواسته (نه یک لایه امنیتی کامل) ----
  if (GATEWAY_SECRET) {
    const provided = req.headers['x-gateway-secret'];
    if (provided !== GATEWAY_SECRET) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'دسترسی غیرمجاز به Gateway.' } });
    }
  }

  try {
    const body = req.body || {};
    const mode = body.mode || 'next-step';
    const requestedProvider = body.provider && body.provider !== 'auto' ? body.provider : DEFAULT_PROVIDER;

    if (mode === 'ping') {
      return res.status(200).json({ success: true, data: { pong: true, defaultProvider: DEFAULT_PROVIDER }, error: null });
    }

    if (mode !== 'next-step') {
      return res.status(400).json({ success: false, error: { code: 'UNSUPPORTED_MODE', message: `mode «${mode}» هنوز پشتیبانی نمی‌شود.` } });
    }

    const { systemPrompt, userPrompt } = buildPrompt(body.context);
    const { text, provider } = await callWithFallback(requestedProvider, systemPrompt, userPrompt);

    return res.status(200).json({ success: true, data: { suggestion: text, provider }, error: null });
  } catch (e) {
    return res.status(500).json({ success: false, data: null, error: { code: 'GATEWAY_ERROR', message: e.message || 'خطای نامشخص در Gateway.' } });
  }
};

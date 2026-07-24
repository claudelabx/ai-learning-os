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

// ---- Prompt Orchestrator برای دسته‌بندی Inbox (سند 008 · مود دوم Gateway) ----
function buildClassifyPrompt(rawText) {
  const systemPrompt =
    'تو یک دستیار دسته‌بندی متن هستی داخل اپلیکیشن «AI Learning OS». ' +
    'کاربر یک متن خام و بدون‌ساختار نوشته. باید تشخیص بدی این متن به کدوم دسته نزدیک‌تره: ' +
    '«Project» (یک پروژه یا هدف بزرگ با چند مرحله)، «Task» (یک کار مشخص و کوچک و قابل انجام)، ' +
    'یا «Note» (یک نکته، ایده یا اطلاعات صرفاً برای نگهداری، بدون نیاز فوری به اقدام). ' +
    'فقط و فقط یک JSON خام و معتبر برگردون، دقیقاً با این شکل، بدون هیچ متن اضافه یا Markdown fence: ' +
    '{"suggested_type": "Project یا Task یا Note", "reason": "یک جملهٔ کوتاه فارسی که دلیل انتخابت رو توضیح بده"}';
  const userPrompt = `متن خام کاربر:\n${rawText}`;
  return { systemPrompt, userPrompt };
}

// ---- Prompt Orchestrator برای AI Interview (سند 012 · زیرفاز 1.5-ج · مود سوم Gateway) ----
// ورودی: یک جمله هدف کاربر. خروجی: Draft 0 = هدف + یک پروژه + حداکثر ۵ تسک اول.
// فیلدهای Goal طبق تصمیم ثبت‌شده کاربر در چت اجرایی: title + reason + success_metric.
function buildInterviewPrompt(goalSentence) {
  const systemPrompt =
    'تو یک منتور برنامه‌ریزی هستی داخل اپلیکیشن «AI Learning OS». ' +
    'کاربر فقط یک جمله درباره هدفش نوشته. تو باید یک پیش‌نویس اولیه (Draft 0) بسازی: ' +
    'یک «هدف» شفاف، یک «پروژه» عملی برای شروع، و حداکثر ۵ «تسک» اولِ کوچک و قابل انجام. ' +
    'همه متن‌ها فارسی، مشخص و بدون کلی‌گویی باشند. ' +
    'فقط و فقط یک JSON خام و معتبر برگردون، دقیقاً با این شکل، بدون هیچ متن اضافه یا Markdown fence: ' +
    '{"goal": {"title": "عنوان کوتاه هدف", "reason": "چرا این هدف مهم است — یک جمله", "success_metric": "با چه معیاری موفقیت سنجیده می‌شود — یک جمله"}, ' +
    '"project": {"title": "عنوان اولین پروژه عملی", "description": "توضیح کوتاه پروژه"}, ' +
    '"tasks": [{"title": "عنوان تسک", "priority": "Low یا Medium یا High یا Critical"}]} ' +
    '— آرایه tasks بین ۱ تا ۵ عضو داشته باشد و اولویت هر تسک را واقع‌بینانه انتخاب کن.';
  const userPrompt = `جمله هدف کاربر:\n${goalSentence}`;
  return { systemPrompt, userPrompt };
}

// ---- فراخوانی Gemini (Google AI Studio — رایگان، بدون کارت بانکی) ----
async function callGemini(systemPrompt, userPrompt, maxTokens = 500) { // eslint-disable-line no-unused-vars — Gemini مثل قبل بدون سقف صریح
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
async function callClaude(systemPrompt, userPrompt, maxTokens = 500) {
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
      max_tokens: maxTokens,
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
async function callOpenAI(systemPrompt, userPrompt, maxTokens = 500) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY تنظیم نشده است.');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: maxTokens,
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
async function callWithFallback(preferredProvider, systemPrompt, userPrompt, maxTokens = 500) {
  const allOrders = {
    gemini: ['gemini', 'claude', 'openai'],
    claude: ['claude', 'gemini', 'openai'],
    openai: ['openai', 'gemini', 'claude'],
  };
  const order = allOrders[preferredProvider] || allOrders.gemini;
  const callers = { gemini: callGemini, claude: callClaude, openai: callOpenAI };
  const errors = {};
  for (const provider of order) {
    try {
      const text = await callers[provider](systemPrompt, userPrompt, maxTokens);
      return { text, provider };
    } catch (e) {
      errors[provider] = e.message || 'خطای نامشخص';
    }
  }
  const combined = Object.entries(errors).map(([p, m]) => `${p}: ${m}`).join(' | ');
  throw new Error(combined || 'هیچ Providerای در دسترس نبود.');
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

    if (mode === 'classify') {
      const rawText = ((body.context && body.context.raw_text) || '').trim();
      if (!rawText) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'raw_text خالی است.' } });
      }
      const { systemPrompt, userPrompt } = buildClassifyPrompt(rawText);
      const { text, provider } = await callWithFallback(requestedProvider, systemPrompt, userPrompt);

      let parsed;
      try {
        const cleaned = text.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch (e) {
        return res.status(502).json({ success: false, error: { code: 'PARSE_ERROR', message: 'پاسخ AI به‌صورت JSON معتبر نبود.' } });
      }
      if (!['Project', 'Task', 'Note'].includes(parsed.suggested_type)) {
        return res.status(502).json({ success: false, error: { code: 'INVALID_SUGGESTION', message: 'نوع پیشنهادی نامعتبر بود.' } });
      }
      return res.status(200).json({
        success: true,
        data: { suggested_type: parsed.suggested_type, reason: parsed.reason || '', provider },
        error: null,
      });
    }

    // ---- مود سوم: interview (سند 012 · زیرفاز 1.5-ج · مصوب سند 003 نسخه 2.2) ----
    // نکته آشتی اسناد (به‌روزشده در پاکسازی پس از فاز 1.5): طبق سند 003 نسخه 2.3 و سند 008
    // نسخه 2.2، الزام ثبت فراخوانی‌ها در جدول ai_logs رسماً به «پیش از فاز عمومی» موکول شد
    // (Future Extensions هر دو سند). دلیل: قید سند 012 هر تغییر Schema در فاز 1.5 را ممنوع
    // کرده و لاگ‌نویسی از Serverless Function نیازمند دسترسی مستقیم Gateway به Supabase است.
    // بنابراین نبودِ لاگ در هر سه مود، رفتار مصوب فعلی است، نه شکاف سند-با-کد.
    if (mode === 'interview') {
      const goalSentence = ((body.context && body.context.goal_sentence) || '').trim();
      if (!goalSentence) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'goal_sentence خالی است.' } });
      }
      const { systemPrompt, userPrompt } = buildInterviewPrompt(goalSentence);
      // سقف بالاتر توکن فقط برای این مود — Draft 0 فارسی از ۵۰۰ توکن بزرگ‌تر است
      const { text, provider } = await callWithFallback(requestedProvider, systemPrompt, userPrompt, 1500);

      let parsed;
      try {
        const cleaned = text.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch (e) {
        return res.status(502).json({ success: false, error: { code: 'PARSE_ERROR', message: 'پاسخ AI به‌صورت JSON معتبر نبود.' } });
      }

      // اعتبارسنجی و نرمال‌سازی ساختار ثابت (بدون Silent Failure — سند 008)
      const validPriorities = ['Low', 'Medium', 'High', 'Critical'];
      const goal = parsed && parsed.goal;
      const project = parsed && parsed.project;
      const rawTasks = parsed && parsed.tasks;
      if (!goal || typeof goal.title !== 'string' || !goal.title.trim() ||
          !project || typeof project.title !== 'string' || !project.title.trim() ||
          !Array.isArray(rawTasks) || rawTasks.length === 0) {
        return res.status(502).json({ success: false, error: { code: 'INVALID_SUGGESTION', message: 'ساختار Draft 0 برگشتی نامعتبر بود.' } });
      }
      const tasks = rawTasks
        .filter((t) => t && typeof t.title === 'string' && t.title.trim())
        .slice(0, 5) // سقف ۵ تسک — قید صریح سند 012
        .map((t) => ({
          title: t.title.trim(),
          priority: validPriorities.includes(t.priority) ? t.priority : 'Medium',
        }));
      if (!tasks.length) {
        return res.status(502).json({ success: false, error: { code: 'INVALID_SUGGESTION', message: 'هیچ تسک معتبری در Draft 0 نبود.' } });
      }

      return res.status(200).json({
        success: true,
        data: {
          draft: {
            goal: {
              title: goal.title.trim(),
              reason: (typeof goal.reason === 'string' ? goal.reason.trim() : ''),
              success_metric: (typeof goal.success_metric === 'string' ? goal.success_metric.trim() : ''),
            },
            project: {
              title: project.title.trim(),
              description: (typeof project.description === 'string' ? project.description.trim() : ''),
            },
            tasks,
          },
          provider,
        },
        error: null,
      });
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

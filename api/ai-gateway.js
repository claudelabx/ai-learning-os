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

// ---- Prompt Orchestrator برای AI Interview (سند 012 · نسخه 1.4 · گفتگومحور · مود سوم Gateway) ----
// ورودی: تاریخچه کامل مکالمه (کاربر/AI). خروجی: یا یک سؤال بعدی، یا Draft نهایی
// {Goal + چند Project فازبندی‌شده + Taskهای تاریخ‌دار}. بدون تغییر زیرساخت (سند 012 نسخه 1.4):
// فقط ارسال تاریخچه در هر فراخوانی + اصلاح System Prompt — همان Serverless Function و سه Provider.
function buildInterviewPrompt(history) {
  const systemPrompt =
    'تو یک منتور برنامه‌ریزی هستی داخل اپلیکیشن «AI Learning OS» و در حال یک مصاحبه گفتگومحور کوتاه با کاربر هستی. ' +
    'هدف: جمع‌کردن اطلاعات کافی (به‌خصوص بازه زمانی، فازها، و ددلاین‌های واقعی) پیش از ساخت پیش‌نویس نهایی. ' +
    'در هر نوبت دقیقاً یکی از این دو کار را انجام بده: ' +
    '(۱) اگر اطلاعات هنوز ناقص است، فقط یک سؤال کوتاه و مشخص دربارهٔ مهم‌ترین جزئیات ناقص بپرس (نه چند سؤال با هم). ' +
    '(۲) اگر اطلاعات کافی جمع شده (یا گفتگو به ۴ سؤال رسیده — در این حالت حتی با اطلاعات ناقص با بهترین حدس منطقی ادامه بده، از سؤال بی‌پایان بپرهیز)، یک پیش‌نویس نهایی بساز. ' +
    'در پیش‌نویس نهایی می‌توانی چند «Project» جدا بسازی (هرکدام معادل یک فاز یا بخش مستقل از هدف کاربر)؛ هر Project حداکثر ۸ Task با تاریخ (در صورت مشخص‌بودن) داشته باشد. تمام متن‌ها فارسی، مشخص و بدون کلی‌گویی باشند. ' +
    'فقط و فقط یکی از این دو ساختار JSON خام را برگردان، بدون هیچ متن اضافه یا Markdown fence:\n' +
    'برای سؤال: {"status": "question", "question": "متن سؤال کوتاه فارسی"}\n' +
    'برای پیش‌نویس نهایی: {"status": "draft", "draft": {"goal": {"title": "...", "reason": "...", "success_metric": "..."}, "projects": [{"title": "...", "description": "...", "tasks": [{"title": "...", "priority": "Low یا Medium یا High یا Critical", "due_date": "YYYY-MM-DD یا null", "planned_date": "YYYY-MM-DD یا null"}]}]}}';
  const transcript = (history || [])
    .map((m) => (m.role === 'user' ? 'کاربر: ' : 'AI: ') + String(m.content || ''))
    .join('\n');
  const userPrompt = 'تاریخچه گفتگو تا این لحظه:\n' + transcript + '\n\nحالا طبق قوانین بالا پاسخ بده.';
  return { systemPrompt, userPrompt };
}

// ---- Prompt Orchestrator برای دستیار زمان‌بندی (اسپرینت Personal Mastery · مود چهارم Gateway) ----
// ورودی: یک جملهٔ لحظه‌ای کاربر + امروز (میلادی/شمسی) + فهرست کوتاه پروژه‌های موجود.
// خروجی: پیش‌نویس یک Task با planned_date (+ در صورت وجود ساعت، start_time/end_time).
// اصل Human in Control: خروجی همیشه پیش‌نویس قابل‌ویرایش است، نه ساخت مستقیم رکورد.
function buildSchedulePrompt(sentence, todayGregorian, todayJalali, todayWeekday, projects) {
  const projectLines = (projects || []).map((p) => `- ${p.id}: ${p.title}`).join('\n') || '(هیچ پروژه‌ای ثبت نشده)';
  const systemPrompt =
    'تو یک دستیار زمان‌بندی هستی داخل اپلیکیشن «AI Learning OS». ' +
    `امروز ${todayWeekday} به‌تاریخ میلادی ${todayGregorian} (شمسی ${todayJalali}) است. ` +
    'کاربر یک جملهٔ کوتاه و لحظه‌ای دربارهٔ یک کار/جلسه می‌نویسد (مثلاً «امروز ۴ تا ۶ جلسه گروهی المپیاد» یا «فردا صبح مطالعهٔ فیزیولوژی»). ' +
    'باید تاریخ نسبی (امروز/فردا/پس‌فردا/نام روز هفته) را به تاریخ میلادی دقیق (YYYY-MM-DD) تبدیل کنی، و اگر ساعت شروع/پایان ذکر شده، آن را به فرمت 24 ساعته HH:MM استخراج کنی (اگر ساعت ذکر نشده، null بگذار). ' +
    'اگر جمله به‌وضوح به یکی از پروژه‌های زیر مرتبط است، شناسهٔ همان پروژه را برگردان؛ در غیر این صورت null. فهرست پروژه‌های موجود:\n' + projectLines + '\n' +
    'فقط و فقط یک JSON خام و معتبر برگردون، دقیقاً با این شکل، بدون هیچ متن اضافه یا Markdown fence: ' +
    '{"title": "عنوان کوتاه کار/جلسه به فارسی", "planned_date": "YYYY-MM-DD", "start_time": "HH:MM یا null", "end_time": "HH:MM یا null", "project_id": "شناسه یا null", "priority": "Low یا Medium یا High یا Critical"}';
  const userPrompt = `جملهٔ کاربر:\n${sentence}`;
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

    // ---- مود سوم: interview (سند 012 نسخه 1.4 · گفتگومحور · مصوب سند 003 نسخه 2.2) ----
    // نکته آشتی اسناد (به‌روزشده در پاکسازی پس از فاز 1.5): طبق سند 003 نسخه 2.3 و سند 008
    // نسخه 2.2، الزام ثبت فراخوانی‌ها در جدول ai_logs رسماً به «پیش از فاز عمومی» موکول شد
    // (Future Extensions هر دو سند). دلیل: قید سند 012 هر تغییر Schema در فاز 1.5 را ممنوع
    // کرده و لاگ‌نویسی از Serverless Function نیازمند دسترسی مستقیم Gateway به Supabase است.
    // بنابراین نبودِ لاگ در هر سه مود، رفتار مصوب فعلی است، نه شکاف سند-با-کد.
    if (mode === 'interview') {
      const history = (body.context && Array.isArray(body.context.history)) ? body.context.history : [];
      const cleanHistory = history
        .filter((m) => m && typeof m.content === 'string' && m.content.trim() && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({ role: m.role, content: m.content.trim() }));
      if (!cleanHistory.length || cleanHistory[cleanHistory.length - 1].role !== 'user') {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'تاریخچه گفتگو باید با یک پیام از کاربر پایان یابد.' } });
      }
      const { systemPrompt, userPrompt } = buildInterviewPrompt(cleanHistory);
      // سقف بالاتر توکن فقط برای این مود — Draft چندپروژه‌ای فارسی از ۵۰۰ توکن بزرگ‌تر است
      const { text, provider } = await callWithFallback(requestedProvider, systemPrompt, userPrompt, 1800);

      let parsed;
      try {
        const cleaned = text.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch (e) {
        return res.status(502).json({ success: false, error: { code: 'PARSE_ERROR', message: 'پاسخ AI به‌صورت JSON معتبر نبود.' } });
      }

      // حالت ۱: AI هنوز سؤال دارد — بدون ساخت هیچ رکورد یا Draft
      if (parsed && parsed.status === 'question') {
        if (typeof parsed.question !== 'string' || !parsed.question.trim()) {
          return res.status(502).json({ success: false, error: { code: 'INVALID_SUGGESTION', message: 'سؤال برگشتی از AI نامعتبر بود.' } });
        }
        return res.status(200).json({
          success: true,
          data: { status: 'question', question: parsed.question.trim(), provider },
          error: null,
        });
      }

      // حالت ۲: Draft نهایی — اعتبارسنجی و نرمال‌سازی ساختار ثابت (بدون Silent Failure — سند 008)
      if (parsed && parsed.status === 'draft') {
        const validPriorities = ['Low', 'Medium', 'High', 'Critical'];
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        const d = parsed.draft;
        const goal = d && d.goal;
        const rawProjects = d && d.projects;
        if (!goal || typeof goal.title !== 'string' || !goal.title.trim() ||
            !Array.isArray(rawProjects) || rawProjects.length === 0) {
          return res.status(502).json({ success: false, error: { code: 'INVALID_SUGGESTION', message: 'ساختار Draft برگشتی نامعتبر بود.' } });
        }
        const projects = rawProjects
          .filter((p) => p && typeof p.title === 'string' && p.title.trim())
          .slice(0, 6) // سقف منطقی تعداد Project در یک Draft
          .map((p) => ({
            title: p.title.trim(),
            description: (typeof p.description === 'string' ? p.description.trim() : ''),
            tasks: (Array.isArray(p.tasks) ? p.tasks : [])
              .filter((t) => t && typeof t.title === 'string' && t.title.trim())
              .slice(0, 8) // سقف ۸ تسک به‌ازای هر Project — قید صریح سند 012
              .map((t) => ({
                title: t.title.trim(),
                priority: validPriorities.includes(t.priority) ? t.priority : 'Medium',
                due_date: (typeof t.due_date === 'string' && dateRe.test(t.due_date)) ? t.due_date : null,
                planned_date: (typeof t.planned_date === 'string' && dateRe.test(t.planned_date)) ? t.planned_date : null,
              })),
          }));
        if (!projects.length) {
          return res.status(502).json({ success: false, error: { code: 'INVALID_SUGGESTION', message: 'هیچ Project معتبری در Draft نبود.' } });
        }
        return res.status(200).json({
          success: true,
          data: {
            status: 'draft',
            draft: {
              goal: {
                title: goal.title.trim(),
                reason: (typeof goal.reason === 'string' ? goal.reason.trim() : ''),
                success_metric: (typeof goal.success_metric === 'string' ? goal.success_metric.trim() : ''),
              },
              projects,
            },
            provider,
          },
          error: null,
        });
      }

      return res.status(502).json({ success: false, error: { code: 'INVALID_SUGGESTION', message: 'ساختار پاسخ AI (status) نامعتبر بود.' } });
    }

    // ---- مود چهارم: schedule (اسپرینت Personal Mastery — دستیار زمان‌بندی لحظه‌ای، بند ۳) ----
    // یادداشت لاگ: مثل سه مود قبلی، بدون ثبت در ai_logs (رجوع به یادداشت آشتی اسناد بالای مود interview).
    if (mode === 'schedule') {
      const ctx = body.context || {};
      const sentence = (ctx.sentence || '').trim();
      if (!sentence) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'sentence خالی است.' } });
      }
      if (!ctx.today_gregorian || !ctx.today_jalali) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'اطلاعات تاریخ امروز (today_gregorian/today_jalali) ارسال نشده.' } });
      }
      const { systemPrompt, userPrompt } = buildSchedulePrompt(
        sentence, ctx.today_gregorian, ctx.today_jalali, ctx.today_weekday || '', ctx.projects || []
      );
      const { text, provider } = await callWithFallback(requestedProvider, systemPrompt, userPrompt, 400);

      let parsed;
      try {
        const cleaned = text.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch (e) {
        return res.status(502).json({ success: false, error: { code: 'PARSE_ERROR', message: 'پاسخ AI به‌صورت JSON معتبر نبود.' } });
      }

      const validPriorities = ['Low', 'Medium', 'High', 'Critical'];
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      const timeRe = /^\d{2}:\d{2}$/;
      if (!parsed || typeof parsed.title !== 'string' || !parsed.title.trim() ||
          typeof parsed.planned_date !== 'string' || !dateRe.test(parsed.planned_date)) {
        return res.status(502).json({ success: false, error: { code: 'INVALID_SUGGESTION', message: 'ساختار پیش‌نویس زمان‌بندی نامعتبر بود.' } });
      }
      const knownProjectIds = (ctx.projects || []).map((p) => p.id);
      return res.status(200).json({
        success: true,
        data: {
          draft: {
            title: parsed.title.trim(),
            planned_date: parsed.planned_date,
            start_time: (typeof parsed.start_time === 'string' && timeRe.test(parsed.start_time)) ? parsed.start_time : null,
            end_time: (typeof parsed.end_time === 'string' && timeRe.test(parsed.end_time)) ? parsed.end_time : null,
            project_id: (typeof parsed.project_id === 'string' && knownProjectIds.includes(parsed.project_id)) ? parsed.project_id : null,
            priority: validPriorities.includes(parsed.priority) ? parsed.priority : 'Medium',
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

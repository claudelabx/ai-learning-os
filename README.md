# AI Learning OS — Deploy روی Vercel (قدم ۲: AI Gateway)

## ساختار پوشه
```
.
├── index.html          ← همون برنامه (قبلاً ai-learning-os.html)
├── api/
│   └── ai-gateway.js    ← Serverless Function (Provider-agnostic: Claude + OpenAI)
└── package.json
```

## مرحله ۱ — ساخت Git Repo
1. یک ریپازیتوری جدید در GitHub بساز (خالی، بدون README).
2. توی همین پوشه (که این فایل‌ها توشن):
   ```bash
   git init
   git add .
   git commit -m "Step 2: AI Gateway"
   git branch -M main
   git remote add origin <آدرس ریپوی گیت‌هاب>
   git push -u origin main
   ```

## مرحله ۲ — اتصال به Vercel
1. برو به [vercel.com](https://vercel.com) → **Add New → Project**.
2. ریپوی گیت‌هابی که بالا ساختی رو انتخاب و **Import** کن.
3. تنظیمات Build رو دست نزن (چون فقط استاتیک + یک تابع سرورless هست، Vercel خودش تشخیص می‌ده).

## مرحله ۳ — Environment Variables
قبل از Deploy (یا بعدش از Project Settings → Environment Variables)، این‌ها رو اضافه کن:

| Key | مقدار | اجباری؟ |
|---|---|---|
| `ANTHROPIC_API_KEY` | کلید API از console.anthropic.com | برای استفاده از Claude |
| `OPENAI_API_KEY` | کلید API از platform.openai.com | برای استفاده از OpenAI |
| `AI_DEFAULT_PROVIDER` | `claude` یا `openai` | اختیاری (پیش‌فرض: claude) |
| `ANTHROPIC_MODEL` | مثلاً `claude-sonnet-4-5` | اختیاری |
| `OPENAI_MODEL` | مثلاً `gpt-4o-mini` | اختیاری |
| `GATEWAY_SECRET` | یک رشته‌ی تصادفی دلخواه (مثلاً از یک Password Generator) | خیلی توصیه‌شده — بدونش هرکسی که آدرس رو پیدا کنه می‌تونه از اعتبار API شما استفاده کنه |

فقط لازم نیست هر دو کلید Provider رو بذاری — همینی که بذاری همون Default می‌شه، و اگه هر دو رو بذاری، Gateway اگه یکی خطا داد خودش دیگری رو امتحان می‌کنه (Fallback).

## مرحله ۴ — Deploy
دکمه‌ی **Deploy** رو بزن. بعد از چند ثانیه، یک آدرس مثل:
```
https://ai-learning-os-xxxx.vercel.app
```
بهت می‌ده. برنامه‌ت روی `/` (همون index.html) و Gateway روی `/api/ai-gateway` در دسترسه.

## مرحله ۵ — وصل کردن برنامه به Gateway
1. برو به همون آدرس Vercel، وارد بخش **Settings** برنامه شو.
2. زیر «اتصال AI Gateway»:
   - **Gateway URL**: `/api/ai-gateway` (چون همون دامنه‌ست، مسیر نسبی کافیه)
   - **Gateway Secret**: همون رشته‌ای که در `GATEWAY_SECRET` گذاشتی
3. «ذخیره و تست اتصال» رو بزن — این فقط یک Ping ساده می‌فرسته، بدون هزینه‌ی API.
4. برو به یک پروژه، تب «کلیات» → دکمه‌ی «پیشنهاد بگیر» رو بزن.

## نکته امنیتی مهم
این برنامه یک فایل استاتیک عمومیه، بدون Login. `GATEWAY_SECRET` تنها لایه‌ی محافظتی در برابر استفاده‌ی ناخواسته/عمومیه — اگه کسی دقیقاً آدرس Gateway و همین Secret رو ببینه (مثلاً از Network tab مرورگر خودت)، می‌تونه ازش استفاده کنه. برای محافظت جدی‌تر، گزینه‌ی «Vercel Deployment Protection» (Password Protection) در تنظیمات پروژه روی Vercel رو هم در نظر بگیر.

# Hisabat Bot — بوت المحاسبة

**An offline-first Arabic Telegram accounting bot for a small telecom-services business.**

Send a plain Arabic message like `وارد بال 150 وي 3ش فهد` — the bot instantly parses it with a
deterministic Arabic command grammar (no LLM required), writes double-entry-style rows to a
Google Sheets ledger, and replies with a receipt carrying a one-tap **undo** button.

Built for an environment with unreliable power and internet: the whole system runs on a laptop
using **polling** (no domain, no HTTPS endpoint, zero hosting cost). Messages queue on Telegram's
servers while offline, and every write is **idempotent** — resending after a network drop
completes the operation instead of duplicating it.

## Highlights

- **Deterministic Arabic parser** (`src/parser.js`): dialect-tolerant normalization (hamza forms,
  taa marbuta, invisible RTL marks injected by phone keyboards, Arabic-Indic digits), shortcuts
  (`وي` = ويكوم, `3ش` = 3 months), order-free field extraction — covered by 55 unit tests.
- **Optional LLM layer**: free-text messages fall back to Claude with JSON-schema-constrained
  structured outputs — and the bot works fully without any API key.
- **Generated n8n workflow** (55 nodes) from a single build script (`build-workflow.js`) with
  graph validation: reachability checks from the trigger, dead-end detection, and per-node
  JavaScript syntax checks.
- **Accounting engine on Google Sheets**: sales, plastic-SIM piece inventory, per-site prepaid
  balances and a debt-ceiling model, receivables (credit sales + organization services), family
  renewals at cost, multi-currency (ILS/USDT) with per-transaction **frozen** FX rates, and
  reconciliation-by-difference for partner withdrawals.
- **Operational hardening learned in production**: at-source Telegram update confirmation (makes
  double-processing across overlapping polls structurally impossible), per-node retries for flaky
  networks, execution-history pruning, and tap-to-copy pinned message templates.
- **Receipts + full undo**: every operation replies with a receipt; the undo button cancels *all*
  rows of the operation across sheets via a message-id audit column (soft-delete, never destructive).

## Architecture

```
Telegram  ⇄  n8n (laptop, 30s polling loop)
              ├─ deterministic Arabic rule parser
              ├─ Claude fallback (optional, JSON-schema output)
              ├─ write planner → idempotent row writes
              └─ receipts / undo / statements / scheduled summaries
                          ⇅
                 Google Sheets ledger (12 sheets, live formulas)
                          ⇅  IMPORTRANGE (read-only mirror)
                 Client-facing shared spreadsheet
```

> **Note:** credential IDs inside `workflow.json` are placeholders — after importing into n8n,
> select your own Telegram / Google Service Account credentials on the highlighted nodes.

---

# الدليل العربي — التركيب والتشغيل

نظام تسجيل مالي عبر تيليجرام: ترسل رسالة → تُكتب في Google Sheets فوراً → يصلك إيصال بزر تراجع.

## بنية المشروع

| الملف | الدور |
|---|---|
| `src/parser.js` | الطبقة الأولى: الصيغة المختصرة (حتمية، بلا نموذج لغوي) |
| `src/config.example.json` | نموذج الإعدادات التي يقرؤها البوت من صفحة «الإعدادات» |
| `prompts/extraction.md` | برومبت الطبقة الثانية (النموذج اللغوي) |
| `test/run-tests.js` | حزمة الاختبار المحلية — `node test/run-tests.js` |
| `workflow.json` | مسار n8n كامل (55 عقدة) — يُستورد مباشرة |
| `build-workflow.js` | مولّد الوورك فلو — عدّل ثم `node build-workflow.js` |
| `docker-compose.yml` | تشغيل n8n على VPS (خيار بديل عن اللابتوب) |
| `ورقة-هيئة-المستقبل.xlsx` | قالب ورقة سجل خدمات جاهز للاستيراد في الشيت |
| `.env.example` | كل المتغيرات المطلوبة |

## خطوات التركيب

### 1. البوت
1. راسل `@BotFather` → `/newbot` → اختر اسماً → **احفظ التوكن**.
2. راسل `@userinfobot` من حساب كل شخص مصرّح له → احفظ الأرقام.

### 2. الشيت
جهّز ملف Google Sheets بالصفحات المطلوبة (لوحة التحكم، الإعدادات، المبيعات والتجديدات،
أرصدة المواقع، الحركات المالية، المصاريف، الملاحظات...) ثم انسخ معرّف الملف من الرابط
(الجزء بين `/d/` و `/edit`).

### 3. التشغيل — اللابتوب هو السيرفر (مجاني)

البوت يعمل **بالسحب الدوري (polling)**: لا يحتاج نطاقاً ولا HTTPS ولا IP ثابت، ويعمل خلف أي راوتر.

**كيف يتعامل مع الانقطاع:** رسائلك تُخزَّن على سيرفرات تيليجرام. الجهاز مطفأ أو بلا نت؟ لا مشكلة —
أول ما يشتغل ويتصل، يسحب كل ما تجمّع ويسجّله بالترتيب وتصلك الإيصالات دفعة واحدة.

> **القيد الوحيد المهم: 24 ساعة.** تيليجرام يحتفظ برسائل البوت غير المسحوبة يوماً واحداً فقط.
> الشرط: أن يتصل الجهاز بالنت مرة على الأقل كل 24 ساعة — وإلا انتقل لخيار الـ VPS.

خطوات ويندوز:
1. انسخ `.env.example` إلى `.env` واملأ كل القيم.
2. شغّل `start-bot.bat` — أول مرة سيثبّت n8n (دقائق).
3. افتح `http://localhost:5678` وأنشئ حساب n8n المحلي.
4. للتشغيل الصامت التلقائي: ضع اختصاراً لـ `start-bot-hidden.vbs` في مجلد Startup.

**الخيار البديل — VPS:** ثبّت Docker ثم `docker compose up -d` من مجلد المشروع (نفس ملف `.env`).

### 4. حساب خدمة جوجل (Service Account)
1. console.cloud.google.com ← مشروع جديد.
2. **APIs & Services ← Library** ← `Google Sheets API` ← **Enable**.
3. **Credentials ← Create Credentials ← Service account** ← Done.
4. افتح الحساب ← **Keys ← Add key ← JSON** ← احتفظ بالملف (`client_email` و `private_key`).
5. شارك ملف الشيتس مع بريد الحساب بصلاحية **محرر**.

### 5. داخل n8n
1. **Credentials — اثنان**: Telegram (التوكن) · **Google API** بحساب الخدمة مع تفعيل
   **Set up for use in HTTP Request node** والنطاق `https://www.googleapis.com/auth/spreadsheets`.
   (مفتاح Anthropic اختياري ويوضع في `.env` لا في n8n.)
2. **استورد** `workflow.json` ← اختر الاعتماد المناسب على العقد الحمراء.
3. **انشر/فعّل** الوورك فلو (زر Publish في نسخ n8n الحديثة — الحفظ وحده لا يشغّل المؤقتات).
4. جرّب `/مساعدة` من تيليجرام — الرد خلال دورة سحب واحدة.

### خصوصية الشيت
لا تجعل الملف «كل من لديه الرابط» — البوت يكفيه بريد حساب الخدمة.
وللمشاركة مع طرف خارجي استعمل ملفاً وسيطاً بدالة `IMPORTRANGE` على النطاق المسموح فقط.

### الاختبار المحلي (بلا تيليجرام)
```
node test/run-tests.js
```

## طبقتا الفهم — ومفتاح Anthropic اختياري
- **الطبقة الأولى (مجانية، دائمة):** الصيغ المختصرة — حتمية وفورية وتغطي كل العمليات.
- **الطبقة الثانية (اختيارية):** فهم الجُمل الحرة عبر Claude بمخرجات مقيّدة بمخطط JSON.
- **بلا مفتاح؟ البوت يعمل عادي** ويرشدك للصيغة المختصرة بدل أن يفشل.

## أبرز الصيغ المدعومة

```
وارد بال 150 وي 3ش فهد          بيع تجديد (وي=ويكوم، 3ش=3 شهور)
شريحة وي 3 شهور 150 بال          نفس البيع بصيغة طبيعية
وارد اجل 150 وي 3ش فهد           بيع دَين — يتسجل على حساب الذمم
حول اجل بال 150                  العميل سدد دينه
وي 1ش الوها انس                  تجديد عائلي: مصروف بالتكلفة + خصم من الموقع، بلا نقد
هيئة 0590000000 64 خالد فاتورة    خدمة لجهة: صادر فعلي + دين على الجهة + سطر سجل
كشف فلسطين شهر                   كشف حساب بمدة + الرصيد الحالي
مطابقة ليان -150                 تسوية بالفرق (تدعم الأرصدة السالبة بنموذج سقف الدين)
شراء بايننس 100 فلسطين           شراء USDT بسعر صرف مثبّت لحظة التنفيذ
```

## قواعد ذهبية
- سعر البيع من الرسالة دائماً؛ التكلفة من جدول التسعير وحده. باقة بلا تكلفة = رفض.
- سعر الصرف يُكتب **رقماً ثابتاً** في الصف لحظة التسجيل — أبداً ليس معادلة.
- الرسالة الواضحة تُسجَّل فوراً + إيصال بزر تراجع. البوت يسأل فقط عند الالتباس.
- التراجع لا يحذف — يعلّم `ملغى` عبر معرّف الرسالة (كل صفوف العملية معاً).

## Status

Complete and operational. The deterministic Arabic parser is covered by a local test suite
(`node test/run-tests.js`), the 55-node n8n workflow is generated and graph-validated by
`build-workflow.js`, and the system has been hardened through production use (at-source update
confirmation, per-node retries, idempotent writes, and full undo). It runs on a laptop via
polling at zero hosting cost, with an optional Docker/VPS deployment path.

## License

MIT

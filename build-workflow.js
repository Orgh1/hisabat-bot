'use strict';
/**
 * يولّد workflow.json لاستيراده في n8n:  node build-workflow.js
 * البنية: استقبال تيليجرام ← فرز/تحقق/منع تكرار ← (نص: المحلل ← نموذج عند الحاجة ← كتابة فورية ← إيصال بزر تراجع)
 *         (زر: تراجع شامل / تثبيت تسوية) ← (أوامر: /مساعدة /رصيد) + ملخص يومي + تذكير مطابقة أسبوعي
 */
const fs = require('fs');
const path = require('path');

const parserSrc = fs
  .readFileSync(path.join(__dirname, 'src', 'parser.js'), 'utf8')
  .replace(/module\.exports[^;]*;/, '');

// ---------------------------------------------------------------- ثوابت مشتركة
const COMMON = `
const TZ = $env.TIMEZONE || 'Asia/Gaza';
const SHEET_ID = $env.GOOGLE_SHEET_ID;
if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID غير معرّف في متغيرات البيئة');
const OWNER = String($env.CHAT_ID_OWNER || '');
const CHAT_IDS = {};
if (OWNER) CHAT_IDS[OWNER] = { name: 'أنا', expenses: null };
if ($env.CHAT_ID_OSAMA) CHAT_IDS[String($env.CHAT_ID_OSAMA)] = { name: 'أسامة', expenses: 'مصروف_اسامة' };
if ($env.CHAT_ID_ANAS) CHAT_IDS[String($env.CHAT_ID_ANAS)] = { name: 'أنس', expenses: 'مصروف_انس' };
const GS = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID;
function todayStr(ts) { return new Date((ts || Math.floor(Date.now()/1000)) * 1000).toLocaleDateString('en-CA', { timeZone: TZ }); }
// خرائط الصفحات: المسح، عمود المفتاح، عمود معرف الرسالة (فهرس داخل نطاق المسح من A)، عمود الحالة
const SHEETS = {
  b: { name: 'المبيعات والتجديدات', scan: 'A5:P204', base: 5, keyCol: 1, msgCol: 15, statusCol: 'M', width: 16 },
  m: { name: 'الحركات المالية',     scan: 'A5:P304', base: 5, keyCol: 1, msgCol: 15, statusCol: 'N', width: 16 },
  '1': { name: 'مصاريف البيت',   scan: 'A5:I154', base: 5, keyCol: 1, msgCol: 8, statusCol: 'G', width: 9 },
  '2': { name: 'مصاريف أسامة',   scan: 'A5:I154', base: 5, keyCol: 1, msgCol: 8, statusCol: 'G', width: 9 },
  '3': { name: 'مصاريف أنس',     scan: 'A5:I154', base: 5, keyCol: 1, msgCol: 8, statusCol: 'G', width: 9 },
  t: { name: 'حركات للترحيل',    scan: 'A5:K104', base: 5, keyCol: 1, msgCol: 10, statusCol: 'H', width: 11 },
  n: { name: 'الملاحظات',        scan: 'A5:F104', base: 5, keyCol: 2, msgCol: 5, statusCol: 'D', width: 6 },
  c: { name: 'أرصدة المواقع',    scan: 'A19:F78',  base: 19, keyCol: 0, msgCol: 4, statusCol: null, width: 6 },
  w: { name: 'أرصدة المواقع',    scan: 'A82:F131', base: 82, keyCol: 0, msgCol: 5, statusCol: null, width: 6 },
  p: { name: 'كشف حساب المنفّذين', scan: 'A16:F65', base: 16, keyCol: 0, msgCol: 4, statusCol: null, width: 6 },
  f: { name: 'هيئة المستقبل', scan: 'A5:H154', base: 5, keyCol: 0, msgCol: 7, statusCol: 'F', width: 8 },
};
function scanUrl(code) { const s = SHEETS[code]; return GS + '/values/' + encodeURIComponent("'" + s.name + "'!" + s.scan) + '?valueRenderOption=UNFORMATTED_VALUE'; }
function rowUrl(code, row) {
  const s = SHEETS[code];
  const endCol = String.fromCharCode(64 + s.width);
  return GS + '/values/' + encodeURIComponent("'" + s.name + "'!A" + row + ':' + endCol + row) + '?valueInputOption=USER_ENTERED';
}
// معالج البيع بالأزرار — واجهة كل خطوة
function wizUI(step) {
  const b = (t, c) => ({ text: t, callback_data: c });
  if (step === 'acc') return { text: '🛒 بيعة جديدة — على أي حساب استلمت؟', kb: [
    [b('💵 كاش', 'wz:acc:كاش'), b('💳 بال باي', 'wz:acc:بال')],
    [b('🏦 فلسطين', 'wz:acc:فلسطين'), b('🏦 الإسلامي', 'wz:acc:اسلامي')],
    [b('📱 جوال باي', 'wz:acc:جوال'), b('🕓 آجل (دين)', 'wz:acc:اجل')],
    [b('❌ إلغاء', 'wz:cancel')]] };
  if (step === 'chip') return { text: 'أي شريحة؟', kb: [
    [b('وي (ويكوم)', 'wz:chip:وي'), b('سيليكوم', 'wz:chip:سيليكوم')],
    [b('هوت موبايل', 'wz:chip:هوت'), b('بارتنر', 'wz:chip:بارتنر')],
    [b('بيليفون', 'wz:chip:بيليفون')],
    [b('❌ إلغاء', 'wz:cancel')]] };
  if (step === 'dur') return { text: 'المدة؟', kb: [
    [b('شهر', 'wz:dur:شهر'), b('3 شهور', 'wz:dur:3ش')],
    [b('📦 شريحة بلاستيك (مخزون)', 'wz:dur:بلاستيك')],
    [b('❌ إلغاء', 'wz:cancel')]] };
  if (step === 'site') return { text: 'أي موقع؟', kb: [
    [b('ليان', 'wz:site:ليان'), b('الوها', 'wz:site:الوها')],
    [b('سكاي', 'wz:site:سكاي'), b('ارين', 'wz:site:ارين')],
    [b('❌ إلغاء', 'wz:cancel')]] };
  if (step === 'amt') return { text: '✍️ اكتب المبلغ واسم العميل (الاسم اختياري)\\nمثال: 150 فهد حلس', kb: null };
  return { text: '👍 أُلغي المعالج.', kb: null };
}
`;

// ---------------------------------------------------------------- سحب التحديثات (polling — يعمل على لابتوب بلا نطاق ولا HTTPS)
const CODE_POLL_PREP = `
const st = $getWorkflowStaticData('global');
const token = $env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN غير معرّف في متغيرات البيئة');
const offset = st.tgOffset || 0;
return [{ json: { url: 'https://api.telegram.org/bot' + token + '/getUpdates?timeout=25&offset=' + offset + '&allowed_updates=' + encodeURIComponent('["message","callback_query"]') } }];
`;

const CODE_POLL_RESERVE = `
// حجز الدفعة: نثبت المؤشر فوراً ونجهز نداء تأكيد الاستلام لتيليجرام —
// التأكيد يحذف الرسائل من طابور تيليجرام نهائياً فلا يمكن لأي دورة متداخلة سحبها ثانية.
// وضع الاختبار (Execute من المحرر) لا يؤكد ولا يحرك المؤشر — حتى لا تُبلع رسائل حقيقية أثناء التجارب.
const st = $getWorkflowStaticData('global');
const resp = $input.first().json;
const updates = (resp && resp.result) || [];
if (!updates.length) return [];
const token = $env.TELEGRAM_BOT_TOKEN;
const isTest = $execution.mode !== 'production';
const nextOffset = updates[updates.length - 1].update_id + 1;
if (!isTest) st.tgOffset = nextOffset;
const confirmUrl = isTest
  ? 'https://api.telegram.org/bot' + token + '/getMe'
  : 'https://api.telegram.org/bot' + token + '/getUpdates?offset=' + nextOffset + '&limit=1&timeout=0';
return [{ json: { updates, confirmUrl } }];
`;

const CODE_POLL_DISPATCH = `
// يقرأ من مدخله المباشر (مخرج «حجز التحديثات») — لا قراءة بالاسم إطلاقاً
const reserved = $input.first().json;
return (reserved.updates || []).map((u) => ({ json: u }));
`;

// ---------------------------------------------------------------- فرز وتحقق (يعالج دفعة تحديثات كاملة)
const CODE_TRIAGE = `${COMMON}
const st = $getWorkflowStaticData('global');
st.seen = st.seen || [];
const out = [];
for (const item of $input.all()) {
  const upd = item.json;
  const msg = upd.message;
  const cb = upd.callback_query;
  const chatId = String(msg ? msg.chat.id : cb ? cb.message.chat.id : '');
  const who = CHAT_IDS[chatId];
  if (!who) continue; // غير مصرّح: تجاهل بصمت
  const updateId = String(upd.update_id);
  if (st.seen.includes(updateId)) continue; // منع تكرار
  st.seen.push(updateId);
  const base = { chatId, sender: who.name, senderExpenses: who.expenses, updateId };
  if (cb) {
    out.push({ json: { ...base, kind: 'callback', callbackId: cb.id, data: cb.data || '' } });
    continue;
  }
  if (!msg || msg.voice || msg.audio) {
    out.push({ json: { ...base, kind: 'command', text: '/صوت' } });
    continue;
  }
  let text = (msg.text || '').trim();
  if (!text) continue;
  const BARE = { 'رصيد': '/رصيد', 'مخزون': '/مخزون', 'مساعدة': '/مساعدة' }; // أزرار اللوحة الدائمة
  if (BARE[text]) text = BARE[text];
  out.push({ json: { ...base, kind: text.startsWith('/') ? 'command' : 'text', msgId: updateId, date: todayStr(msg.date), replyTo: msg.message_id, text } });
}
if (st.seen.length > 500) st.seen = st.seen.slice(-300);
return out;
`;

// ---------------------------------------------------------------- المحلل
const CODE_PARSER = `${COMMON}
${parserSrc}
const textItems = $('فرز وتحقق').all().filter((x) => x.json.kind === 'text');
const allOut = [];
$input.all().forEach((respItem, respIdx) => {
const ranges = respItem.json.valueRanges || [];
const settings = (ranges[0] && ranges[0].values) || [];
const sites = (ranges[1] && ranges[1].values) || [];
const ctx = textItems[respIdx].json;

// بناء الإعدادات من صفحة «الإعدادات» A1:G110
function cell(r, c) { return (settings[r - 1] || [])[c] !== undefined ? settings[r - 1][c] : ''; }
const config = {
  accounts: {}, accountCurrencies: {}, binanceAccount: 'محفظة بايننس',
  dests: { 'بيت': 'مصاريف البيت', 'اسامة': 'مصاريف أسامة', 'انس': 'مصاريف أنس' },
  destTypes: { 'مصاريف البيت': 'مصروف_بيت', 'مصاريف أسامة': 'مصروف_اسامة', 'مصاريف أنس': 'مصروف_انس' },
  chips: { 'ويكوم': 'ويكوم', 'وي': 'ويكوم', 'سيليكوم': 'سيليكوم', 'هوت': 'هوت موبايل', 'بارتنر': 'بارتنر', 'بيليفون': 'بيليفون' },
  sites: [], defaultSite: 'ليان', executorName: 'أبو حسام',
  fxRate: parseFloat(cell(49, 2)) || 3, pricing: {},
};
for (let r = 5; r <= 34; r++) { const k = cell(r, 5); if (k) config.pricing[k] = cell(r, 4) === '' ? null : parseFloat(cell(r, 4)); }
for (let r = 37; r <= 46; r++) { const nameAcc = cell(r, 1); if (nameAcc) { config.accountCurrencies[nameAcc] = cell(r, 3) || 'شيكل'; } }
// الاختصارات الأساسية مدمجة دائماً؛ صفوف الشيت (النوع=حساب) تضيف أو تغلب
config.accounts = { 'فلسطين': 'بنك فلسطين', 'بنك': 'بنك فلسطين', 'البنك': 'بنك فلسطين', 'اسلامي': 'البنك الإسلامي الفلسطيني', 'بال': 'محفظة بال باي', 'جوال': 'محفظة جوال باي', 'بايننس': 'محفظة بايننس', 'كاش': 'كاش', 'اجل': 'آجل', 'هيئة': 'هيئة المستقبل', 'جوالي': 'رصيد جوال' };
config.defaultServiceAccount = 'رصيد جوال';
for (let r = 64; r <= 87; r++) { const sc = cell(r, 1); if (sc && cell(r, 3) === 'حساب') config.accounts[sc] = cell(r, 2); }
const siteBalances = {};
for (const row of sites) { if (row && row[1]) { config.sites.push(String(row[1])); siteBalances[String(row[1])] = parseFloat(row[6]) || 0; } }
if (!config.sites.length) config.sites = ['ليان', 'الوها', 'سكاي', 'ارين'];
const inventory = {};
for (let r = 106; r <= 110; r++) { if (cell(r, 0)) inventory[cell(r, 0)] = parseFloat(cell(r, 5)) || 0; }

// جواب سؤال معلّق: لا يُدمج في التحليل القاعدي (حتى لا تتضاعف العمليات) —
// يُرفق فقط كسياق للنموذج اللغوي عند السطر غير المفهوم، ولمرة واحدة
const st = $getWorkflowStaticData('global');
st.clarify = st.clarify || {};
let pend = st.clarify[ctx.chatId];
if (pend && (pend.v !== 2 || Date.now() - pend.ts > 30 * 60 * 1000)) { delete st.clarify[ctx.chatId]; pend = null; }
if (pend) delete st.clarify[ctx.chatId];

// —— معالج البيع بالأزرار ——
st.wizard = st.wizard || {};
let wiz = st.wizard[ctx.chatId];
if (wiz && Date.now() - wiz.ts > 60 * 60 * 1000) { delete st.wizard[ctx.chatId]; wiz = null; } // ساعة — تحمّلاً للانقطاعات
let effText = ctx.text;
const bareWord = normalize(ctx.text);
// (مدخل معالج الأزرار معطَّل بقرار المستخدم — القوالب المثبتة أنسب لواقع الانقطاع)
if (wiz && (bareWord === 'الغاء' || bareWord === 'إلغاء')) {
  delete st.wizard[ctx.chatId];
  allOut.push({ json: { wiz: true, chatId: ctx.chatId, text: '👍 أُلغي المعالج.', kb: null } });
  return;
}
if (wiz && wiz.step === 'amt') {
  const mtoks = normalize(ctx.text).split(/\s+/);
  const amtTok = mtoks.find((t) => isNumber(t) && parseFloat(t) > 0);
  if (!amtTok) {
    allOut.push({ json: { wiz: true, chatId: ctx.chatId, text: 'أرسل رقم المبلغ (مع الاسم اختياراً)\\nمثال: 150 فهد حلس', kb: null } });
    return;
  }
  delete st.wizard[ctx.chatId];
  const client = ctx.text.split(/\s+/).filter((t) => normalize(t) !== amtTok).join(' ');
  effText = ['وارد', wiz.d.acc, amtTok]
    .concat(wiz.d.dur === 'بلاستيك' ? ['بلاستيك', wiz.d.chip] : [wiz.d.chip, wiz.d.dur])
    .concat(wiz.d.site && wiz.d.site !== 'ليان' ? [wiz.d.site] : [])
    .concat(client ? [client] : [])
    .join(' ');
}

const parsed = parseMessage(effText, config);
const pricingTable = Object.entries(config.pricing).map(([k, v]) => k + ' ← ' + (v === null ? 'غير مدخلة' : v)).join('\\n');
const schema = {
  type: 'object', additionalProperties: false,
  required: ['نوع_العملية','المبلغ','العملة','الحساب','الحساب_المقابل','المنفّذ','الاتجاه','الموقع','نوع_التجديد','اسم_العميل','معرف_الاشتراك','البند','التصنيف','نص_الملاحظة','الثقة','يحتاج_توضيح','سؤال_التوضيح'],
  properties: {
    'نوع_العملية': { type: 'string', enum: ['بيع','بيع_بلاستيك','مصروف_بيت','مصروف_اسامة','مصروف_انس','شحن_رصيد','تحويل_داخلي','شراء_USDT','بيع_USDT','تسوية_مطابقة','تسديد','ملاحظة','حركة_عامة'] },
    'المبلغ': { type: ['number','null'] }, 'العملة': { type: 'string', enum: ['شيكل','USDT'] },
    'الحساب': { type: ['string','null'] }, 'الحساب_المقابل': { type: ['string','null'] },
    'المنفّذ': { type: 'string' }, 'الاتجاه': { type: ['string','null'], enum: ['وارد','صادر',null] },
    'الموقع': { type: ['string','null'] }, 'نوع_التجديد': { type: ['string','null'] },
    'اسم_العميل': { type: ['string','null'] }, 'معرف_الاشتراك': { type: ['string','null'] },
    'البند': { type: ['string','null'] }, 'التصنيف': { type: ['string','null'] }, 'نص_الملاحظة': { type: ['string','null'] },
    'الثقة': { type: 'number' }, 'يحتاج_توضيح': { type: 'boolean' }, 'سؤال_التوضيح': { type: ['string','null'] },
  },
};
const out = [];
parsed.lines.forEach((line, i) => {
  const base = { ...ctx, opIndex: i, opCount: parsed.lines.length, config: { fxRate: config.fxRate, pricing: config.pricing, accountCurrencies: config.accountCurrencies, defaultSite: config.defaultSite }, siteBalances, inventory, needsLLM: false };
  if (line.matched) { out.push({ json: { ...base, op: line.op } }); return; }
  const fbText = pend ? pend.text + ' — توضيح المستخدم: ' + line.fallback : line.fallback;
  if (pend) pend = null; // يُستهلك مرة واحدة
  if (!$env.ANTHROPIC_API_KEY) {
    // بلا مفتاح Anthropic: الطبقة الثانية معطلة — نرشد للصيغة المختصرة بدل الفشل
    out.push({ json: { ...base, op: { 'يحتاج_توضيح': true,
      'سؤال_التوضيح': 'لم أفهم الرسالة. استعمل الصيغة المختصرة — أرسل /مساعدة للأمثلة. (فهم النص الحر يتفعّل بإضافة مفتاح Anthropic في ملف .env)',
      'النص_الأصلي': line.fallback } } });
    return;
  }
  const prompt = 'أنت طبقة استخراج بيانات في نظام محاسبة. حوّل الرسالة العربية العامية التالية إلى JSON حسب المخطط المفروض.\\n' +
    'جدول التجديدات (المفتاح ← التكلفة):\\n' + pricingTable + '\\n' +
    'الحسابات: ' + Object.values(config.accounts).join(' · ') + '\\nالمواقع: ' + config.sites.join(' · ') + '\\n' +
    'تاريخ اليوم: ' + base.date + '\\nمرسل الرسالة: ' + ctx.sender + '\\n' +
    'القواعد: أي معلومة غير موجودة صراحة = null ولا تخمن أبداً. المبلغ من الرسالة لا من جدول التسعير (استثناء: بيع بلاستيك بلا مبلغ = تكلفته). ' +
    '"ورد/دخل/استلمت/اجاني"=وارد، "دفعت/صادر/طلع"=صادر. "امبارح"=اليوم-1. ' +
    'نوع_التجديد بصيغة "الشريحة - المدة - الموقع": الشريحة والمدة كما في الجدول، والموقع المذكور بالرسالة (وإلا ليان) حتى لو لم يكن مفتاح ذلك الموقع في الجدول. "وي" تعني ويكوم. ' +
    '"بنك/البنك" = بنك فلسطين، "اسلامي" = البنك الإسلامي الفلسطيني. "المحفظة" وحدها ملتبسة (بال باي/جوال باي) = يحتاج_توضيح بسؤال عربي قصير واحد. ' +
    '"بالدين / آجل / بعدين يدفع / لسا ما دفع" = الحساب آجل. "سدد الدين / حوّل اللي عليه" = تحويل_داخلي من آجل إلى الحساب المذكور. ' +
    (ctx.senderExpenses ? 'مصروف شخصي بلا وجهة = ' + ctx.senderExpenses + ' (هوية المرسل). ' : 'مصروف شخصي بلا وجهة محددة = يحتاج_توضيح: لمن؟ ') +
    'الثقة أقل من 0.7 = يحتاج_توضيح.\\n\\nالرسالة: «' + fbText + '»';
  out.push({ json: { ...base, needsLLM: true, fallbackText: fbText,
    llmBody: { model: $env.ANTHROPIC_MODEL || 'claude-opus-5', max_tokens: 2000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }] } } });
});
allOut.push(...out);
});
return allOut;
`;

// ---------------------------------------------------------------- قراءة رد النموذج
const CODE_LLM_PARSE = `
const fallbacks = $('المحلل').all().filter((s) => s.json.needsLLM);
const out = [];
$input.all().forEach((item, idx) => {
  const resp = item.json;
  const ctx = (fallbacks[idx] && fallbacks[idx].json) || {};
  let op = null; let clarifyQ = null;
  if (resp.stop_reason === 'refusal') {
    clarifyQ = 'تعذّر فهم الرسالة — أعد صياغتها.';
  } else {
    try {
      const txt = (resp.content || []).find((b) => b.type === 'text');
      op = JSON.parse(txt.text);
    } catch (e) { clarifyQ = 'تعذّر تحليل الرسالة — أعد الإرسال بصيغة أوضح أو بالصيغة المختصرة.'; }
  }
  if (op) {
    op['النص_الأصلي'] = ctx.fallbackText || '';
    if (op['يحتاج_توضيح']) { clarifyQ = op['سؤال_التوضيح'] || 'وضّح العملية أكثر.'; op = null; }
  }
  out.push({ json: { ...ctx, op: op || { 'يحتاج_توضيح': true, 'سؤال_التوضيح': clarifyQ, 'النص_الأصلي': ctx.fallbackText || '' }, needsLLM: false, llmBody: undefined } });
});
return out;
`;

// ---------------------------------------------------------------- خطة الكتابة
const CODE_PLAN = `${COMMON}
const st = $getWorkflowStaticData('global');
st.pendingSettle = st.pendingSettle || {};
st.clarify = st.clarify || {};
const out = [];
for (const item of $input.all()) {
  const j = item.json;
  if (j.wiz) { out.push({ json: { stage: 'wiz', chatId: j.chatId, text: j.text, kb: j.kb } }); continue; }
  const op = j.op;
  const key = j.msgId + (j.opCount > 1 ? ':' + j.opIndex : '');
  const D = j.date; const fx = j.config.fxRate;
  const opLabel = j.opCount > 1 ? ' (عملية ' + (j.opIndex + 1) + '/' + j.opCount + ')' : '';

  if (op['يحتاج_توضيح']) {
    st.clarify[j.chatId] = { v: 2, text: op['النص_الأصلي'] || j.text, ts: Date.now() };
    out.push({ json: { stage: 'ask', chatId: j.chatId, replyTo: j.replyTo, text: '❓ ' + (op['سؤال_التوضيح'] || 'وضّح العملية.') + opLabel + '\\n📝 «' + (op['النص_الأصلي'] || j.text) + '»\\nأجب على هذه الرسالة أو أعد الإرسال كاملاً.' } });
    continue;
  }

  const type = op['نوع_العملية'];
  const amt = op['المبلغ'];
  const acc = op['الحساب'];
  const writes = []; // { code, values: مصفوفة بطول width تبدأ من A مع null للمعادلات }
  function row(code, map) { const s = SHEETS[code]; const v = new Array(s.width).fill(null); for (const [col, val] of Object.entries(map)) v[col.charCodeAt(0) - 65] = val; writes.push({ code, values: v }); }
  let receipt = ''; let warn = '';

  if (type === 'بيع' || type === 'بيع_بلاستيك') {
    let cost = op._derived && op._derived.cost !== undefined ? op._derived.cost : j.config.pricing[op['نوع_التجديد']];
    if (cost === undefined || cost === null) {
      // مفتاح موقع غير مُدرج في جدول التسعير (من النموذج اللغوي): التكلفة موحّدة — خذ تكلفة الموقع الافتراضي
      const parts = String(op['نوع_التجديد'] || '').split(' - ');
      if (parts.length === 3) cost = j.config.pricing[parts[0] + ' - ' + parts[1] + ' - ' + (j.config.defaultSite || 'ليان')];
    }
    if (cost === undefined || cost === null) {
      st.clarify[j.chatId] = { v: 2, text: op['النص_الأصلي'] || j.text, ts: Date.now() };
      out.push({ json: { stage: 'ask', chatId: j.chatId, replyTo: j.replyTo, text: '❓ تكلفة «' + (op['نوع_التجديد'] || 'الباقة') + '» غير مُدخلة في جدول التسعير — أدخلها ثم أعد الإرسال.' + opLabel } });
      continue;
    }
    const profit = amt - cost;
    const chip = (op._derived && (op._derived.chip || (op._derived.stock && op._derived.stock.chip))) || String(op['نوع_التجديد'] || '').split(' - ')[0] || null;
    const siteLit = type === 'بيع_بلاستيك' ? 'مخزون' : op['الموقع'];
    // الشريحة والموقع والتكلفة تُكتب قيماً ثابتة: يجعل الخصم يعمل لكل المواقع دون تكرار صفوف التسعير
    row('b', { B: D, C: op['المنفّذ'] || 'أنا', D: op['اسم_العميل'], E: op['معرف_الاشتراك'], F: op['نوع_التجديد'], G: amt, H: chip, I: siteLit, J: cost, L: acc, M: 'مؤكد', P: key });
    row('m', { B: D, C: (type === 'بيع_بلاستيك' ? 'بيع شريحة بلاستيك' : 'تجديد') + (op['اسم_العميل'] ? ' — ' + op['اسم_العميل'] : ''), D: 'مبيعات / تجديد', E: 'وارد', F: acc, G: 'شيكل', I: amt, N: 'مؤكد', P: key });
    receipt = '📥 وارد ' + amt + ' ₪ · ' + acc + '\\n🔄 ' + op['نوع_التجديد'] + '\\n➖ التكلفة: ' + cost + ' ₪ · 💰 الربح: ' + profit + ' ₪';
    if (type === 'بيع_بلاستيك') {
      const chip = op._derived && op._derived.stock ? op._derived.stock.chip : '';
      const left = (j.inventory[chip] || 0) - 1;
      receipt += '\\n📦 مخزون ' + chip + ' بعد البيع: ' + left;
      if (left <= 0) warn = '⚠️ مخزون ' + chip + ' نفد أو تحت الحد!';
    } else {
      const site = op['الموقع'];
      const bal = (j.siteBalances[site] || 0) - cost;
      receipt += '\\n🏝 رصيد ' + site + ' التقريبي بعد الخصم: ' + bal + ' ₪';
    }
    if (acc === 'آجل') receipt += '\\n💳 بيع آجل — يبقى ديناً على العميل. عند السداد أرسل: حول اجل <الحساب> ' + amt;
  } else if (type === 'مصروف_بيت' || type === 'مصروف_اسامة' || type === 'مصروف_انس') {
    const code = type === 'مصروف_بيت' ? '1' : type === 'مصروف_اسامة' ? '2' : '3';
    row(code, { B: D, C: op['البند'] || '', D: op['التصنيف'], E: amt, F: acc, G: 'مؤكد', I: key });
    row('m', { B: D, C: (op['البند'] || 'مصروف'), D: type === 'مصروف_بيت' ? 'مصروف بيت' : type === 'مصروف_اسامة' ? 'مصروف أسامة' : 'مصروف أنس', E: 'صادر', F: acc, G: 'شيكل', J: amt, N: 'مؤكد', P: key });
    receipt = '📤 صادر ' + amt + ' ₪ · ' + acc + '\\n🏷 ' + SHEETS[code].name + (op['البند'] ? ' — ' + op['البند'] : '');
  } else if (type === 'شحن_رصيد') {
    row('c', { A: D, B: op['الموقع'], C: amt, D: acc, E: key });
    row('m', { B: D, C: 'شحن رصيد موقع ' + op['الموقع'], D: 'شحن رصيد موقع', E: 'صادر', F: acc, G: 'شيكل', J: amt, N: 'مؤكد', P: key });
    receipt = '⚡ شحن ' + op['الموقع'] + ': ' + amt + ' ₪ من ' + acc;
  } else if (type === 'تحويل_داخلي') {
    row('m', { B: D, C: 'تحويل إلى ' + op['الحساب_المقابل'], D: 'تحويل بين الحسابات', E: 'صادر', F: acc, G: 'شيكل', J: amt, N: 'مؤكد', P: key });
    row('m', { B: D, C: 'تحويل من ' + acc, D: 'تحويل بين الحسابات', E: 'وارد', F: op['الحساب_المقابل'], G: 'شيكل', I: amt, N: 'مؤكد', P: key });
    receipt = '🔁 تحويل ' + amt + ' ₪: ' + acc + ' ← ' + op['الحساب_المقابل'];
  } else if (type === 'شراء_USDT' || type === 'بيع_USDT') {
    const shekel = Math.round(amt * fx * 100) / 100;
    if (type === 'شراء_USDT') {
      row('m', { B: D, C: 'شراء ' + amt + ' USDT', D: 'تحويل بين الحسابات', E: 'صادر', F: op['الحساب_المقابل'], G: 'شيكل', J: shekel, N: 'مؤكد', P: key });
      row('m', { B: D, C: 'شراء USDT — سعر مثبّت ' + fx, D: 'تحويل بين الحسابات', E: 'وارد', F: 'محفظة بايننس', G: 'USDT', H: fx, I: amt, N: 'مؤكد', P: key });
      receipt = '🪙 شراء ' + amt + ' USDT × ' + fx + ' = ' + shekel + ' ₪ من ' + op['الحساب_المقابل'];
    } else {
      row('m', { B: D, C: 'بيع ' + amt + ' USDT — سعر مثبّت ' + fx, D: 'تحويل بين الحسابات', E: 'صادر', F: 'محفظة بايننس', G: 'USDT', H: fx, J: amt, N: 'مؤكد', P: key });
      row('m', { B: D, C: 'بيع USDT', D: 'تحويل بين الحسابات', E: 'وارد', F: op['الحساب_المقابل'], G: 'شيكل', I: shekel, N: 'مؤكد', P: key });
      receipt = '🪙 بيع ' + amt + ' USDT × ' + fx + ' = ' + shekel + ' ₪ إلى ' + op['الحساب_المقابل'];
    }
  } else if (type === 'تسديد') {
    row('p', { A: D, B: op['المنفّذ'] || 'أبو حسام', C: amt, D: acc, E: key });
    row('m', { B: D, C: 'تسديد من ' + (op['المنفّذ'] || 'أبو حسام'), D: 'تسديد من منفّذ', E: 'وارد', F: acc, G: 'شيكل', I: amt, N: 'مؤكد', P: key });
    receipt = '🤝 تسديد ' + amt + ' ₪ من ' + (op['المنفّذ'] || 'أبو حسام') + ' على ' + acc;
  } else if (type === 'تجديد_عائلي') {
    // تكلفة التجديد مصروف على صاحبه + خصم من رصيد الموقع — بلا أي حركة نقدية
    const cost = op._derived.cost;
    const chip = op._derived.chip;
    const expCode = op._derived.expenseType === 'مصروف_بيت' ? '1' : op._derived.expenseType === 'مصروف_اسامة' ? '2' : '3';
    const who = op['اسم_العميل'];
    row('b', { B: D, C: 'أنا', D: who, F: op['نوع_التجديد'], G: cost, H: chip, I: op['الموقع'], J: cost, M: 'مؤكد', N: 'تجديد عائلي — قُيّد مصروفاً', P: key });
    row(expCode, { B: D, C: 'تجديد ' + chip + ' ' + (op._derived.dur || '') + ' (' + op['الموقع'] + ')', E: cost, G: 'مؤكد', H: 'من رصيد الموقع — بلا نقد', I: key });
    receipt = '👪 تجديد عائلي (' + who + '): ' + op['نوع_التجديد'] +
      '\\n➖ خصم ' + cost + ' ₪ من رصيد ' + op['الموقع'] +
      ' · 💸 قُيّد ' + cost + ' ₪ على ' + SHEETS[expCode].name +
      '\\nبلا حركة نقدية — الربح غير متأثر.';
  } else if (type === 'كشف_حساب') {
    const days = (op._derived && op._derived.days) || 30;
    const sinceSerial = Math.floor(Date.now() / 86400000) - days + 25569; // تاريخ البداية بتسلسل جداول البيانات
    // قراءة مزدوجة: حركات الحساب + أرصدة لوحة التحكم (للرصيد الحالي)
    const stmtUrl = GS + '/values:batchGet?valueRenderOption=UNFORMATTED_VALUE'
      + '&ranges=' + encodeURIComponent("'الحركات المالية'!A5:P304")
      + '&ranges=' + encodeURIComponent("'لوحة التحكم'!B17:H26");
    out.push({ json: { stage: 'statement', chatId: j.chatId, accountName: acc, days, sinceSerial, scanUrl: stmtUrl } });
    continue;
  } else if (type === 'خدمة_هيئة') {
    row('f', { A: D, B: op['معرف_الاشتراك'], C: op['البند'], D: amt, E: op['اسم_العميل'], F: 'مؤكد', H: key });
    row('m', { B: D, C: 'خدمة هيئة المستقبل — ' + (op['البند'] || ''), D: 'أخرى', E: 'صادر', F: acc, G: 'شيكل', J: amt, N: 'مؤكد', P: key });
    row('m', { B: D, C: 'دين هيئة المستقبل — ' + (op['البند'] || ''), D: 'أخرى', E: 'وارد', F: 'هيئة المستقبل', G: 'شيكل', I: amt, N: 'مؤكد', P: key });
    receipt = '🏛 خدمة هيئة المستقبل: ' + (op['البند'] || '—') + (op['معرف_الاشتراك'] ? '\\n📱 ' + op['معرف_الاشتراك'] : '') +
      '\\n📤 ' + amt + ' ₪ من ' + acc + ' · 💳 أُضيف لدين الهيئة' +
      (op['اسم_العميل'] ? '\\n👤 طالب الخدمة: ' + op['اسم_العميل'] : '') +
      '\\nعند التسديد: حول هيئة <الحساب> <المبلغ>';
  } else if (type === 'ملاحظة') {
    row('n', { B: D, C: op['نص_الملاحظة'], D: 'مفتوحة', F: key });
    receipt = '🗒 ملاحظة جديدة: «' + op['نص_الملاحظة'] + '»';
  } else if (type === 'تسوية_مطابقة') {
    // الاستثناء الوحيد الثالث: تثبيت التسوية خلف تأكيد
    const site = op['الموقع'];
    const actual = amt;
    const computed = j.siteBalances[site] !== undefined ? j.siteBalances[site] : null;
    if (computed === null) {
      out.push({ json: { stage: 'ask', chatId: j.chatId, replyTo: j.replyTo, text: '❓ لا أجد رصيداً محسوباً للموقع ' + site } });
      continue;
    }
    const diff = Math.round((actual - computed) * 100) / 100;
    if (diff === 0) {
      out.push({ json: { stage: 'ask', chatId: j.chatId, replyTo: j.replyTo, text: '✅ ' + site + ' مطابق تماماً (' + computed + ' ₪) — لا حاجة لتسوية.' } });
      continue;
    }
    if (diff > 0) {
      out.push({ json: { stage: 'ask', chatId: j.chatId, replyTo: j.replyTo, text: '⚠️ فرق موجب في ' + site + ': الفعلي ' + actual + ' والمحسوب ' + computed + ' (+' + diff + ' ₪).\\nلا يُثبَّت على أحد — راجع سجل الشحن، فالغالب شحن غير مسجّل.' } });
      continue;
    }
    const withdrawal = Math.abs(diff);
    st.pendingSettle[key] = { ts: Date.now(), chatId: j.chatId, writes: [ { code: 'w', values: (() => { const v = new Array(6).fill(null); v[0] = D; v[1] = site; v[2] = withdrawal; v[3] = 'أبو حسام'; v[4] = actual; v[5] = key; return v; })() } ], receipt: '⚖️ تسوية ' + site + ': ثُبّت سحب ' + withdrawal + ' ₪ على أبي حسام (الفعلي ' + actual + ' ₪).' };
    out.push({ json: { stage: 'confirm', chatId: j.chatId, replyTo: j.replyTo, settleKey: key,
      text: '⚖️ مطابقة ' + site + opLabel + '\\nالمحسوب: ' + computed + ' ₪ · الفعلي: ' + actual + ' ₪ · الفرق: ' + diff + ' ₪\\n\\n⚠️ تأكد أن كل عملياتك مسجّلة أولاً — أي عملية منسية ستُحسب ديناً على أبي حسام.\\nتثبيت ' + withdrawal + ' ₪ سحباً على أبي حسام؟' } });
    continue;
  } else {
    // حركة عامة أو ترحيل
    const route = op._derived && op._derived.route === 'حركات للترحيل';
    if (route) {
      row('t', { B: D, C: acc, D: op['الاتجاه'], E: amt, F: op['النص_الأصلي'], H: 'بانتظار الترحيل', K: key });
      receipt = '📮 أُودعت في «حركات للترحيل» بانتظار التوجيه: ' + amt + ' ₪ ' + (op['الاتجاه'] || '') + ' · ' + acc + '\\nاستعمل /معلق و /رحل لاحقاً.';
    } else {
      const cur = op['العملة'] || 'شيكل';
      const isUSDT = cur === 'USDT';
      row('m', { B: D, C: op['البند'] || 'حركة عامة', D: op['التصنيف'] || 'أخرى', E: op['الاتجاه'], F: acc, G: cur, H: isUSDT ? fx : null, I: op['الاتجاه'] === 'وارد' ? amt : null, J: op['الاتجاه'] === 'صادر' ? amt : null, N: 'مؤكد', P: key });
      receipt = (op['الاتجاه'] === 'وارد' ? '📥 وارد ' : '📤 صادر ') + amt + ' ' + (isUSDT ? 'USDT (× ' + fx + ')' : '₪') + ' · ' + acc + (op['البند'] ? '\\n🏷 ' + op['البند'] : '');
    }
  }

  const sheetCodes = [...new Set(writes.map((w) => w.code))].join('');
  writes.forEach((w, wi) => {
    out.push({ json: { stage: 'write', chatId: j.chatId, replyTo: j.replyTo, msgKey: key, opKey: key, writeIndex: wi,
      code: w.code, values: w.values, scanUrl: scanUrl(w.code),
      receipt: wi === 0 ? '✅ تم التسجيل' + opLabel + '\\n' + receipt + '\\n📅 ' + D + '\\n📝 «' + (op['النص_الأصلي'] || j.text) + '»' + (warn ? '\\n' + warn : '') : null,
      undoData: 'undo:' + key + ':' + sheetCodes } });
  });
}
return out;
`;

// ---------------------------------------------------------------- تحديد الصف (لكل عناصر الدفعة معاً — يوزّع الصفوف فلا تتصادم كتابتان على نفس الصفحة)
const CODE_FIND_ROW = `${COMMON}
const resps = $input.all();
function planFor(i) {
  // مطابقة العنصر بمصدره عبر سلسلة pairedItem — صامدة أمام تعدد الفروع وترتيب العناصر
  try { const p = $('خطة الكتابة').itemMatching(i); if (p && p.json && p.json.stage === 'write') return p.json; } catch (e) {}
  try { const p = $('قراءة الزر').itemMatching(i); if (p && p.json && p.json.stage === 'write') return p.json; } catch (e) {}
  throw new Error('تعذر مطابقة خطة الكتابة للعنصر رقم ' + i);
}
const allocated = {}; // code → الصف الفارغ التالي في هذا التنفيذ
const out = [];
resps.forEach((respItem, i) => {
  const plan = planFor(i);
  const sheet = SHEETS[plan.code];
  const data = respItem.json.values || [];
  const existing = data.filter((r) => String((r || [])[sheet.msgCol] || '') === String(plan.msgKey)).length;
  const skip = existing > plan.writeIndex; // إعادة إرسال: الصف موجود مسبقاً
  let firstEmpty = null;
  for (let r = 0; r < data.length + 1; r++) {
    const row = data[r] || [];
    if (row[sheet.keyCol] === undefined || row[sheet.keyCol] === '') { firstEmpty = sheet.base + r; break; }
  }
  const maxRow = parseInt(sheet.scan.match(/(\\d+)$/)[1], 10);
  if (firstEmpty === null || firstEmpty > maxRow) {
    if (!skip) throw new Error('لا يوجد صف فارغ في ' + sheet.name + ' — وسّع الجدول');
    firstEmpty = maxRow;
  }
  if (allocated[plan.code] === undefined || allocated[plan.code] < firstEmpty) allocated[plan.code] = firstEmpty;
  let target = null;
  if (!skip) { target = allocated[plan.code]; allocated[plan.code]++; }
  out.push({ json: { ...plan, skip, targetRow: target,
    putUrl: skip ? null : rowUrl(plan.code, target),
    body: skip ? null : { values: [plan.values] } } });
});
return out;
`;

// ---------------------------------------------------------------- الإيصال
const CODE_RECEIPT = `
const groups = {};
for (const item of $input.all()) {
  const j = item.json;
  if (!groups[j.opKey]) groups[j.opKey] = { chatId: j.chatId, replyTo: j.replyTo, undoData: j.undoData, receipt: null, rows: [], skipped: 0 };
  if (j.receipt) groups[j.opKey].receipt = j.receipt;
  if (j.skip) groups[j.opKey].skipped++; else groups[j.opKey].rows.push(j.targetRow);
}
return Object.values(groups).map((g) => ({ json: {
  chatId: g.chatId, replyTo: g.replyTo, undoData: g.undoData,
  text: (g.receipt || '✅ تم التسجيل') + (g.skipped ? '\\nℹ️ ' + g.skipped + ' صف كان مسجلاً سابقاً (لا تكرار).' : ''),
} }));
`;

// ---------------------------------------------------------------- الأزرار
const CODE_CALLBACK = `${COMMON}
const st = $getWorkflowStaticData('global');
st.pendingSettle = st.pendingSettle || {};
const out = [];
for (const item of $input.all()) {
  const j = item.json;
  const d = j.data || '';
  if (d.startsWith('settle:no:')) {
    delete st.pendingSettle[d.slice(10)];
    out.push({ json: { action: 'msg', chatId: j.chatId, text: '👍 أُلغيت التسوية — لم يُكتب شيء.' } });
  } else if (d.startsWith('settle:ok:')) {
    const key = d.slice(10);
    const p = st.pendingSettle[key];
    if (!p) { out.push({ json: { action: 'msg', chatId: j.chatId, text: '⌛ انتهت صلاحية طلب التسوية — أعد إرسال «مطابقة ...».' } }); continue; }
    delete st.pendingSettle[key];
    p.writes.forEach((w, wi) => out.push({ json: { action: 'write', stage: 'write', chatId: j.chatId, replyTo: null, msgKey: key, opKey: key, writeIndex: wi, code: w.code, values: w.values, scanUrl: scanUrl(w.code), receipt: wi === 0 ? p.receipt : null, undoData: 'undo:' + key + ':w' } }));
  } else if (d.startsWith('undo:')) {
    const parts = d.split(':');
    const key = parts[1];
    const codes = (parts[2] || 'bm123tncwp').split('');
    codes.forEach((code) => out.push({ json: { action: 'undo', chatId: j.chatId, msgKey: key, code, scanUrl: scanUrl(code) } }));
  } else if (d.startsWith('wz:')) {
    st.wizard = st.wizard || {};
    const parts = d.split(':');
    const act = parts[1]; const val = parts[2];
    if (act === 'cancel') {
      delete st.wizard[j.chatId];
      out.push({ json: { action: 'wiz', stage: 'wiz', chatId: j.chatId, text: '👍 أُلغي المعالج.', kb: null } });
    } else {
      const wiz = st.wizard[j.chatId] || { step: 'acc', d: {}, ts: Date.now() };
      wiz.ts = Date.now();
      if (act === 'acc') { wiz.d.acc = val; wiz.step = 'chip'; }
      else if (act === 'chip') { wiz.d.chip = val; wiz.step = 'dur'; }
      else if (act === 'dur') { wiz.d.dur = val; wiz.step = val === 'بلاستيك' ? 'amt' : 'site'; }
      else if (act === 'site') { wiz.d.site = val; wiz.step = 'amt'; }
      st.wizard[j.chatId] = wiz;
      const ui = wizUI(wiz.step);
      out.push({ json: { action: 'wiz', stage: 'wiz', chatId: j.chatId, text: ui.text, kb: ui.kb } });
    }
  } else {
    out.push({ json: { action: 'msg', chatId: j.chatId, text: 'زر غير معروف.' } });
  }
}
return out;
`;

const CODE_UNDO_CELLS = `${COMMON}
const resp = $json;
const plan = $('قراءة الزر').itemMatching($itemIndex).json;
const s = SHEETS[plan.code];
const data = resp.values || [];
const updates = [];
for (let i = 0; i < data.length; i++) {
  const r = data[i] || [];
  if (String(r[s.msgCol] || '') !== String(plan.msgKey)) continue;
  const rowNum = s.base + i;
  if (s.statusCol) {
    updates.push({ range: "'" + s.name + "'!" + s.statusCol + rowNum, values: [['ملغى']] });
  } else {
    const endCol = String.fromCharCode(64 + s.width);
    updates.push({ range: "'" + s.name + "'!A" + rowNum + ':' + endCol + rowNum, values: [new Array(s.width).fill('')] });
  }
}
return { json: { chatId: plan.chatId, msgKey: plan.msgKey, found: updates.length,
  batchUrl: updates.length ? GS + '/values:batchUpdate' : null,
  batchBody: updates.length ? { valueInputOption: 'USER_ENTERED', data: updates } : null } };
`;

const CODE_UNDO_DONE = `${COMMON}
// العدّاد يُقرأ من عقدة «خلايا الإلغاء» نفسها — مخرجات HTTP بعدها هي رد جوجل ولا تحمل found
let items;
try { items = $('خلايا الإلغاء').all(); } catch (e) { items = $input.all(); }
let found = 0; let chatId = null;
for (const item of items) { found += item.json.found || 0; chatId = chatId || item.json.chatId; }
chatId = chatId || OWNER;
return [{ json: { chatId, text: found ? '↩️ تم الإلغاء — ' + found + ' صف عُلّم «ملغى» أو مُسح، والأرصدة عادت لما قبل العملية.' : '⚠️ لم أجد صفوفاً بهذا المعرّف (ربما أُلغيت سابقاً).' } }];
`;

// ---------------------------------------------------------------- كشف الحساب
const CODE_STATEMENT = `
const plan = $('خطة الكتابة').itemMatching($itemIndex).json;
const ranges = $json.valueRanges || [];
const rows = (ranges[0] && ranges[0].values) || $json.values || [];
const dash = (ranges[1] && ranges[1].values) || [];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let inSum = 0; let outSum = 0; const lines = [];
for (const r of rows) {
  if (!r || r[1] === undefined || r[1] === '') continue;
  if (String(r[5] || '') !== String(plan.accountName)) continue;
  if (String(r[13] || '') !== 'مؤكد') continue;
  const serial = typeof r[1] === 'number' ? r[1] : null;
  if (serial !== null && serial < plan.sinceSerial) continue;
  const dt = serial !== null ? new Date((serial - 25569) * 86400000).toISOString().slice(0, 10) : String(r[1]);
  const inc = parseFloat(r[10]) || 0;
  const outv = parseFloat(r[11]) || 0;
  inSum += inc; outSum += outv;
  lines.push(dt + ' · ' + esc(r[2] || '—') + ' · ' + (inc ? '+' + inc : '-' + outv) + ' ₪');
}
const MAX = 40;
const body = lines.slice(-MAX).join('\\n');
const note = lines.length > MAX ? '\\n(عرضت آخر ' + MAX + ' من أصل ' + lines.length + ' حركة)' : '';
const net = Math.round((inSum - outSum) * 100) / 100;
// الرصيد الحالي من لوحة التحكم (العمود G بالعملة، H بالشيكل)
let balLine = '';
for (const dr of dash) {
  if (dr && String(dr[0] || '') === String(plan.accountName)) {
    const cur = String(dr[1] || 'شيكل');
    const balCur = Math.round((parseFloat(dr[5]) || 0) * 100) / 100;
    const balIls = Math.round((parseFloat(dr[6]) || 0) * 100) / 100;
    balLine = '\\n💰 الرصيد الحالي: ' + (cur === 'شيكل' ? balIls + ' ₪' : balCur + ' ' + cur + ' (' + balIls + ' ₪)');
    break;
  }
}
const text = '📄 كشف ' + plan.accountName + ' — آخر ' + plan.days + ' يوم\\n\\n' +
  (body || 'لا حركات مؤكدة في هذه المدة.') + note +
  '\\n\\n📥 وارد: ' + inSum + ' ₪ · 📤 صادر: ' + outSum + ' ₪ · الصافي: ' + net + ' ₪' + balLine;
return { json: { chatId: plan.chatId, text } };
`;

// ---------------------------------------------------------------- الأوامر
const CODE_COMMANDS = `${COMMON}
const out = [];
for (const item of $input.all()) {
const j = item.json;
const cmd = j.text.split(/\\s+/)[0].replace('/', '');
const TPL = ['وارد بال 150 وي 3ش الاسم','وارد كاش 150 وي 3ش الاسم','وارد اجل 150 وي 3ش الاسم','وارد كاش 40 بلاستيك وي الاسم','هيئة 0590000000 64 خالد فاتورة شهر 7','حول هيئة بال 500','حول جوال جوالي 100','كشف فلسطين شهر','كشف هيئة اسبوع','وي 1ش الوها انس','صادر فلسطين 50 بيت البيان','صادر كاش 50 بيت البيان','حول اجل بال 150','حول فلسطين بال 200','شحن ليان 500 فلسطين','شراء بايننس 100 فلسطين','مطابقة ليان -150','سدد 300 فلسطين','ملاحظة نص الملاحظة'];
const TPLTEXT = '📌 القوالب — المس أي سطر يُنسَخ، عدّل وأرسل:\\n\\n' + TPL.map((t) => '<code>' + t + '</code>').join('\\n') + '\\n\\nوي=ويكوم · 3ش=3 شهور · ش=شهر · اجل=بيع دين';
const HELP = '🤖 /قوالب — سطور جاهزة تنسخها بلمسة وتعدّل الرقم والاسم فقط (مثبتة أيضاً أعلى المحادثة).\\n\\nالأوامر: /رصيد /قوالب /مساعدة\\n(بقية الأوامر — /اليوم /شهر /معلق /رحل /تم /ملاحظات /ذمم /كشف /سعر /فحص — في المرحلة 4)\\n\\n📝 صيغ سريعة:\\n' +
 'وارد بال 60 وي شهر احمد\\nشريحة وي 3 شهور 150 بال\\nوارد كاش 40 بلاستيك سيليكوم\\nوارد اجل 60 وي شهر احمد ← بيع دَين\\nحول اجل بال 60 ← العميل سدد دينه\\nصادر اسلامي 300 بيت إيجار\\nشحن ليان 500 فلسطين\\nحول فلسطين بال 200\\nشراء بايننس 100 فلسطين\\nمطابقة ليان -150\\nسدد 300 فلسطين\\nملاحظة اشتري شرائح\\n\\n«وي» = ويكوم · «3ش» = 3 شهور · «ش» = شهر. كل رسالة واضحة تُسجَّل فوراً ويصلك إيصال بزر تراجع.';
if (cmd === 'رصيد' || cmd === 'balance') out.push({ json: { needDash: true, chatId: j.chatId } });
else if (cmd === 'قوالب' || cmd === 'templates') out.push({ json: { needDash: false, chatId: j.chatId, text: TPLTEXT } });
else if (cmd === 'صوت') out.push({ json: { needDash: false, chatId: j.chatId, text: '🎤 الرسائل الصوتية تصل في المرحلة 5 — اكتب نصاً حالياً.' } });
else if (cmd === 'مساعدة' || cmd === 'start' || cmd === 'help') out.push({ json: { needDash: false, chatId: j.chatId, text: HELP } });
else out.push({ json: { needDash: false, chatId: j.chatId, text: 'الأمر /' + cmd + ' يُنجز في المرحلة 4.\\n' + HELP } });
}
return out;
`;

const CODE_DASH_FORMAT = `${COMMON}
const ranges = $json.valueRanges || [];
const dash = (ranges[0] && ranges[0].values) || [];
const sites = (ranges[1] && ranges[1].values) || [];
const inv = (ranges[2] && ranges[2].values) || [];
const ctx = $('الأوامر').all().length ? $('الأوامر').first().json : { chatId: OWNER };
function n(x) { return x === undefined || x === '' ? '—' : (Math.round(parseFloat(x) * 100) / 100); }
let t = '📊 الأرصدة\\n\\n🏦 الحسابات:\\n';
for (const r of dash) { if (r && r[0] && r[6] !== undefined && r[6] !== '') t += '· ' + r[0] + ': ' + n(r[5]) + (String(r[1]) === 'USDT' ? ' USDT (' + n(r[6]) + ' ₪)' : ' ₪') + '\\n'; }
t += '\\n🏝 المواقع:\\n';
for (const r of sites) { if (r && r[1]) t += '· ' + r[1] + ': ' + n(r[6]) + ' ₪' + (String(r[13] || '') === 'سقف دين' ? ' (متاح للسحب: ' + n(r[15]) + ' ₪)' : '') + '\\n'; }
t += '\\n📦 مخزون البلاستيك:\\n';
for (const r of inv) { if (r && r[0]) t += '· ' + r[0] + ': ' + n(r[5]) + ' قطعة\\n'; }
return [{ json: { chatId: ctx.chatId, text: t } }];
`;

const CODE_SUMMARY = `${COMMON}
const kind = $json.summaryKind;
const ranges = $json.valueRanges || [];
const dash = (ranges[0] && ranges[0].values) || [];
const sites = (ranges[1] && ranges[1].values) || [];
const inv = (ranges[2] && ranges[2].values) || [];
function n(x) { return x === undefined || x === '' ? '—' : (Math.round(parseFloat(x) * 100) / 100); }
if (kind === 'weekly') {
  let t = '⏰ تذكير المطابقة الأسبوعي\\nسجّل عملياتك أولاً ثم افتح المواقع وأرسل:\\n';
  for (const r of sites) { if (r && r[1]) t += '· مطابقة ' + r[1] + ' <الرصيد الفعلي>\\n'; }
  t += '(القيمة قد تكون سالبة لليان)';
  return [{ json: { chatId: OWNER, text: t } }];
}
let t = '🌙 ملخص اليوم ' + todayStr() + '\\n\\n🏦 الحسابات:\\n';
for (const r of dash) { if (r && r[0] && r[6] !== undefined && r[6] !== '') t += '· ' + r[0] + ': ' + n(r[5]) + (String(r[1]) === 'USDT' ? ' USDT' : ' ₪') + '\\n'; }
t += '\\n🏝 المواقع:\\n';
for (const r of sites) { if (r && r[1]) { t += '· ' + r[1] + ': ' + n(r[6]) + ' ₪'; const status = String(r[11] || ''); if (status.includes('⚠')) t += ' ' + status; t += '\\n'; } }
t += '\\n📦 المخزون: ' + inv.filter((r) => r && r[0]).map((r) => r[0] + ' ' + n(r[5])).join(' · ');
return [{ json: { chatId: OWNER, text: t } }];
`;

// ---------------------------------------------------------------- بناء العقد
// معرّفات الاعتمادات من n8n المحلي (لو أعدت إنشاء الاعتمادات في n8n حدّث المعرفات هنا وأعد التوليد)
const CREDS = {
  telegram: { id: 'SELECT_YOUR_CREDENTIAL', name: 'Telegram account' },
  google: { id: 'SELECT_YOUR_CREDENTIAL', name: 'Google Service Account' },
};
let nid = 0;
function node(name, type, typeVersion, position, parameters, extra) {
  nid++;
  return { id: 'n' + String(nid).padStart(3, '0'), name, type, typeVersion, position, parameters, ...(extra || {}) };
}
function codeNode(name, pos, js, each) {
  return node(name, 'n8n-nodes-base.code', 2, pos, { ...(each ? { mode: 'runOnceForEachItem' } : {}), jsCode: js });
}
function ifStr(name, pos, left, val) {
  return node(name, 'n8n-nodes-base.if', 1, pos, { conditions: { string: [{ value1: left, value2: val }] } });
}
// إعادة محاولة تلقائية على مستوى العقدة — تبتلع انقطاعات النت اللحظية
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 };
function gsGet(name, pos, urlExpr) {
  return node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
    method: 'GET', url: urlExpr,
    authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi', options: {},
  }, { ...RETRY });
}
function gsWrite(name, pos, method, urlExpr, bodyExpr) {
  return node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
    method, url: urlExpr,
    authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi',
    sendBody: true, specifyBody: 'json', jsonBody: bodyExpr, options: {},
  }, { ...RETRY });
}
function tgSend(name, pos, textExpr, keyboard, html) {
  const p = { chatId: '={{ $json.chatId }}', text: textExpr, additionalFields: { appendAttribution: false, ...(html ? { parse_mode: 'HTML' } : {}) } };
  if (keyboard === 'undo') {
    p.replyMarkup = 'inlineKeyboard';
    p.inlineKeyboard = { rows: [{ row: { buttons: [{ text: '❌ تراجع', additionalFields: { callback_data: '={{ $json.undoData }}' } }] } }] };
  } else if (keyboard === 'settle') {
    p.replyMarkup = 'inlineKeyboard';
    p.inlineKeyboard = { rows: [{ row: { buttons: [
      { text: '✅ ثبّت على أبي حسام', additionalFields: { callback_data: "={{ 'settle:ok:' + $json.settleKey }}" } },
      { text: '❌ إلغاء', additionalFields: { callback_data: "={{ 'settle:no:' + $json.settleKey }}" } },
    ] } }] };
  }
  return node(name, 'n8n-nodes-base.telegram', 1.2, pos, p, { ...RETRY });
}

const DASH_BATCH_URL =
  "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + $env.GOOGLE_SHEET_ID + '/values:batchGet?valueRenderOption=UNFORMATTED_VALUE' + '&ranges=' + encodeURIComponent(\"'لوحة التحكم'!B17:H26\") + '&ranges=' + encodeURIComponent(\"'أرصدة المواقع'!A5:P12\") + '&ranges=' + encodeURIComponent(\"'الإعدادات'!A106:G110\") }}";
const SETTINGS_BATCH_URL =
  "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + $env.GOOGLE_SHEET_ID + '/values:batchGet?valueRenderOption=UNFORMATTED_VALUE' + '&ranges=' + encodeURIComponent(\"'الإعدادات'!A1:G110\") + '&ranges=' + encodeURIComponent(\"'أرصدة المواقع'!A5:P12\") }}";

const nodes = [];
const C = {}; // الاتصالات

// —— السحب الدوري والفرز (polling: يعمل على لابتوب بلا نطاق، ويلتقط كل ما تجمّع أثناء الانقطاع)
nodes.push(node('سحب الرسائل', 'n8n-nodes-base.scheduleTrigger', 1.2, [-2060, 300], {
  rule: { interval: [{ field: 'cronExpression', expression: '*/30 * * * * *' }] },
}));
nodes.push(codeNode('طلب التحديثات', [-1840, 300], CODE_POLL_PREP));
nodes.push(node('جلب التحديثات', 'n8n-nodes-base.httpRequest', 4.2, [-1620, 340], {
  method: 'GET', url: '={{ $json.url }}', options: { timeout: 35000 },
}, { onError: 'continueRegularOutput', continueOnFail: true, retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 }));
nodes.push(codeNode('حجز التحديثات', [-1620, 180], CODE_POLL_RESERVE));
nodes.push(node('تأكيد الاستلام', 'n8n-nodes-base.httpRequest', 4.2, [-1500, 180], {
  method: 'GET', url: '={{ $json.confirmUrl }}', options: { timeout: 15000 },
}, { onError: 'continueRegularOutput', continueOnFail: true, retryOnFail: true, maxTries: 4, waitBetweenTries: 2000 }));
nodes.push(codeNode('توزيع التحديثات', [-1400, 300], CODE_POLL_DISPATCH));
nodes.push(codeNode('فرز وتحقق', [-1180, 300], CODE_TRIAGE));
nodes.push(ifStr('زر؟', [-960, 300], '={{ $json.kind }}', 'callback'));
nodes.push(ifStr('أمر؟', [-740, 420], '={{ $json.kind }}', 'command'));
C['سحب الرسائل'] = ['طلب التحديثات'];
C['طلب التحديثات'] = ['جلب التحديثات'];
C['جلب التحديثات'] = ['حجز التحديثات'];
// التأكيد فرع موازٍ مستقل (طريق مسدود) — التوزيع يستلم مباشرة من الحجز
C['حجز التحديثات'] = [['توزيع التحديثات', 'تأكيد الاستلام']];
C['توزيع التحديثات'] = ['فرز وتحقق'];
C['فرز وتحقق'] = ['زر؟'];
C['زر؟'] = [['قراءة الزر', 'رد على الزر'], ['أمر؟']];
C['أمر؟'] = [['الأوامر'], ['قراءة الإعدادات']];

// —— مسار النص
nodes.push(gsGet('قراءة الإعدادات', [-520, 560], SETTINGS_BATCH_URL));
nodes.push(codeNode('المحلل', [-300, 560], CODE_PARSER));
nodes.push(ifStr('يحتاج النموذج؟', [-80, 560], '={{ String($json.needsLLM) }}', 'true'));
nodes.push(node('استخراج بالنموذج', 'n8n-nodes-base.httpRequest', 4.2, [140, 460], {
  method: 'POST', url: 'https://api.anthropic.com/v1/messages',
  sendHeaders: true, headerParameters: { parameters: [
    { name: 'anthropic-version', value: '2023-06-01' },
    { name: 'x-api-key', value: '={{ $env.ANTHROPIC_API_KEY }}' },
  ] },
  sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.llmBody) }}', options: {},
}, { ...RETRY }));
nodes.push(codeNode('قراءة رد النموذج', [360, 460], CODE_LLM_PARSE));
nodes.push(codeNode('خطة الكتابة', [580, 560], CODE_PLAN));
nodes.push(ifStr('كتابة؟', [800, 560], '={{ $json.stage }}', 'write'));
nodes.push(ifStr('كشف؟', [1020, 840], '={{ $json.stage }}', 'statement'));
nodes.push(gsGet('قراءة الكشف', [1240, 900], '={{ $json.scanUrl }}'));
nodes.push(codeNode('تنسيق الكشف', [1460, 900], CODE_STATEMENT, true));
nodes.push(ifStr('تأكيد تسوية؟', [1020, 700], '={{ $json.stage }}', 'confirm'));
nodes.push(gsGet('مسح الصفوف', [1020, 460], '={{ $json.scanUrl }}'));
nodes.push(codeNode('تحديد الصف', [1240, 460], CODE_FIND_ROW));
nodes.push(ifStr('صف جديد؟', [1460, 460], '={{ String($json.skip) }}', 'false'));
nodes.push(gsWrite('كتابة الصف', [1680, 380], 'PUT', '={{ $json.putUrl }}', '={{ JSON.stringify($json.body) }}'));
nodes.push(codeNode('تجهيز ما كُتب', [1900, 460], 'return $input.all().map(i => ({ json: $("تحديد الصف").all()[$input.all().indexOf(i)] ? i.json : i.json }));'));
nodes.push(codeNode('بناء الإيصال', [2120, 460], CODE_RECEIPT));
nodes.push(tgSend('إرسال الإيصال', [2340, 460], '={{ $json.text }}', 'undo'));
nodes.push(tgSend('إرسال سؤال', [1240, 780], '={{ $json.text }}'));
nodes.push(tgSend('طلب تأكيد التسوية', [1240, 640], '={{ $json.text }}', 'settle'));
nodes.push(ifStr('خطوة معالج؟', [1020, 840], '={{ $json.stage }}', 'wiz'));
nodes.push(node('إرسال خطوة المعالج', 'n8n-nodes-base.httpRequest', 4.2, [1240, 900], {
  method: 'POST',
  url: "={{ 'https://api.telegram.org/bot' + $env.TELEGRAM_BOT_TOKEN + '/sendMessage' }}",
  sendBody: true, specifyBody: 'json',
  jsonBody: '={{ JSON.stringify({ chat_id: $json.chatId, text: $json.text, reply_markup: $json.kb ? { inline_keyboard: $json.kb } : undefined }) }}',
  options: {},
}));
C['قراءة الإعدادات'] = ['المحلل'];
C['المحلل'] = ['يحتاج النموذج؟'];
C['يحتاج النموذج؟'] = [['استخراج بالنموذج'], ['خطة الكتابة']];
C['استخراج بالنموذج'] = ['قراءة رد النموذج'];
C['قراءة رد النموذج'] = ['خطة الكتابة'];
C['خطة الكتابة'] = ['كتابة؟'];
C['كتابة؟'] = [['مسح الصفوف'], ['خطوة معالج؟']];
C['خطوة معالج؟'] = [['إرسال خطوة المعالج'], ['كشف؟']];
C['كشف؟'] = [['قراءة الكشف'], ['تأكيد تسوية؟']];
C['قراءة الكشف'] = ['تنسيق الكشف'];
C['تنسيق الكشف'] = ['رد الأوامر'];
C['تأكيد تسوية؟'] = [['طلب تأكيد التسوية'], ['إرسال سؤال']];
C['مسح الصفوف'] = ['تحديد الصف'];
C['تحديد الصف'] = ['صف جديد؟'];
C['صف جديد؟'] = [['كتابة الصف'], ['تجهيز ما كُتب']];
C['كتابة الصف'] = ['تجهيز ما كُتب'];
C['تجهيز ما كُتب'] = ['بناء الإيصال'];
C['بناء الإيصال'] = ['إرسال الإيصال'];

// «تجهيز ما كُتب» يمرر كما هو — لكن كتابة الصف تُرجع رد جوجل؛ نحتاج تمرير سياق الخطة:
// نستبدل كوده بالتقاط عناصر «تحديد الصف» مباشرة.
nodes.find((n) => n.name === 'تجهيز ما كُتب').parameters.jsCode =
  'return $("تحديد الصف").all().map((i) => ({ json: i.json }));';

// —— مسار الأزرار
// الرد على ضغطة الزر يفشل غالباً مع السحب الدوري (تيليجرام يقبله خلال ثوانٍ فقط) — نكمل رغم الفشل
nodes.push(node('رد على الزر', 'n8n-nodes-base.telegram', 1.2, [-740, 140], {
  resource: 'callback', queryId: '={{ $json.callbackId }}',
}, { onError: 'continueRegularOutput', continueOnFail: true }));
nodes.push(codeNode('قراءة الزر', [-520, 140], CODE_CALLBACK));
nodes.push(ifStr('تثبيت تسوية؟', [-300, 140], '={{ $json.action }}', 'write'));
nodes.push(ifStr('تراجع؟', [-80, 200], '={{ $json.action }}', 'undo'));
nodes.push(gsGet('مسح للتراجع', [140, 140], '={{ $json.scanUrl }}'));
nodes.push(codeNode('خلايا الإلغاء', [360, 140], CODE_UNDO_CELLS, true));
nodes.push(ifStr('يوجد ما يُلغى؟', [580, 140], '={{ String($json.found > 0) }}', 'true'));
nodes.push(gsWrite('تنفيذ الإلغاء', [800, 80], 'POST', '={{ $json.batchUrl }}', '={{ JSON.stringify($json.batchBody) }}'));
nodes.push(codeNode('تلخيص الإلغاء', [1020, 140], CODE_UNDO_DONE));
nodes.push(tgSend('رسالة الإلغاء', [1240, 140], '={{ $json.text }}'));
nodes.push(tgSend('رسالة الزر', [140, 280], '={{ $json.text }}'));
nodes.push(ifStr('خطوة معالج زر؟', [-80, 320], '={{ $json.stage }}', 'wiz'));
C['قراءة الزر'] = ['تثبيت تسوية؟'];
C['تثبيت تسوية؟'] = [['مسح الصفوف'], ['تراجع؟']];
C['تراجع؟'] = [['مسح للتراجع'], ['خطوة معالج زر؟']];
C['خطوة معالج زر؟'] = [['إرسال خطوة المعالج'], ['رسالة الزر']];
C['مسح للتراجع'] = ['خلايا الإلغاء'];
C['خلايا الإلغاء'] = ['يوجد ما يُلغى؟'];
C['يوجد ما يُلغى؟'] = [['تنفيذ الإلغاء'], ['تلخيص الإلغاء']];
C['تنفيذ الإلغاء'] = ['تلخيص الإلغاء'];
C['تلخيص الإلغاء'] = ['رسالة الإلغاء'];


// —— الأوامر
nodes.push(codeNode('الأوامر', [-520, 20], CODE_COMMANDS));
nodes.push(ifStr('قراءة اللوحة؟', [-300, 20], '={{ String($json.needDash) }}', 'true'));
nodes.push(gsGet('قراءة اللوحة', [-80, -40], DASH_BATCH_URL));
nodes.push(codeNode('تنسيق الرصيد', [140, -40], CODE_DASH_FORMAT));
nodes.push(tgSend('رد الأوامر', [360, 20], '={{ $json.text }}', null, true));
C['الأوامر'] = ['قراءة اللوحة؟'];
C['قراءة اللوحة؟'] = [['قراءة اللوحة'], ['رد الأوامر']];
C['قراءة اللوحة'] = ['تنسيق الرصيد'];
C['تنسيق الرصيد'] = ['رد الأوامر'];

// —— الملخص اليومي وتذكير المطابقة
nodes.push(node('الملخص اليومي', 'n8n-nodes-base.scheduleTrigger', 1.2, [-1400, -160], {
  rule: { interval: [{ field: 'cronExpression', expression: '0 21 * * *' }] },
}));
nodes.push(node('تذكير المطابقة', 'n8n-nodes-base.scheduleTrigger', 1.2, [-1400, -20], {
  rule: { interval: [{ field: 'cronExpression', expression: '0 10 * * 5' }] },
}));
nodes.push(codeNode('نوع الملخص: يومي', [-1180, -160], "return [{ json: { summaryKind: 'daily' } }];"));
nodes.push(codeNode('نوع الملخص: أسبوعي', [-1180, -20], "return [{ json: { summaryKind: 'weekly' } }];"));
nodes.push(gsGet('قراءة اللوحة للملخص', [-960, -90], DASH_BATCH_URL));
nodes.push(codeNode('تنسيق الملخص', [-740, -90], CODE_SUMMARY));
nodes.push(tgSend('إرسال الملخص', [-520, -90], '={{ $json.text }}'));
C['الملخص اليومي'] = ['نوع الملخص: يومي'];
C['تذكير المطابقة'] = ['نوع الملخص: أسبوعي'];
C['نوع الملخص: يومي'] = ['قراءة اللوحة للملخص'];
C['نوع الملخص: أسبوعي'] = ['قراءة اللوحة للملخص'];
C['قراءة اللوحة للملخص'] = ['تنسيق الملخص'];
C['تنسيق الملخص'] = ['إرسال الملخص'];
// تمرير نوع الملخص عبر القراءة: احفظه في التنسيق من العقدة السابقة
nodes.find((n) => n.name === 'تنسيق الملخص').parameters.jsCode = CODE_SUMMARY.replace(
  'const kind = $json.summaryKind;',
  "let kind = 'daily'; try { kind = $('نوع الملخص: أسبوعي').first().json.summaryKind; } catch (e) { try { kind = $('نوع الملخص: يومي').first().json.summaryKind; } catch (e2) {} }",
);

// —— ربط الاعتمادات تلقائياً بكل العقد التي تحتاجها
for (const n of nodes) {
  if (n.type === 'n8n-nodes-base.telegram') n.credentials = { telegramApi: CREDS.telegram };
  if (n.parameters && n.parameters.nodeCredentialType === 'googleApi') n.credentials = { googleApi: CREDS.google };
}

// —— الاتصالات بصيغة n8n
const connections = {};
for (const [from, to] of Object.entries(C)) {
  const outputs = Array.isArray(to[0]) ? to : [to];
  connections[from] = { main: outputs.map((names) => names.map((n2) => ({ node: n2, type: 'main', index: 0 }))) };
}

const workflow = {
  name: 'بوت المحاسبة',
  nodes,
  connections,
  settings: { executionOrder: 'v1', timezone: 'Asia/Gaza' },
  pinData: {},
};

fs.writeFileSync(path.join(__dirname, 'workflow.json'), JSON.stringify(workflow, null, 2), 'utf8');
console.log('workflow.json written:', nodes.length, 'nodes');

'use strict';
/**
 * الطبقة الأولى — محلّل الصيغة المختصرة (حتمي، بلا نموذج لغوي).
 * يعمل محلياً في الاختبارات وداخل عقدة Code في n8n بلا تعديل.
 *
 * parseMessage(text, config) → { lines: [ {matched, op?, fallback?} ] }
 *   matched=true  + op          : عملية جاهزة (قد تكون يحتاج_توضيح=true بسؤال محدد)
 *   matched=false + fallback    : السطر لا يطابق الصيغة — يُرسل للنموذج اللغوي
 */

const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const FILLERS = new Set(['من', 'الي', 'إلى', 'على', 'عن', 'ل', 'لـ', 'في']);

function stripInvisible(s) {
  // علامات الاتجاه والمحارف الخفية التي تحشرها لوحات مفاتيح الهواتف (RLM/LRM/ZWJ/BOM/NBSP...)
  return String(s).replace(/[ ​-‏‪-‮⁠-⁩﻿]/g, ' ');
}

function normalize(s) {
  return stripInvisible(s)
    .replace(/[٠-٩]/g, (d) => AR_DIGITS[d])
    .replace(/[ً-ْٰـ]/g, '') // تشكيل وتطويل
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

function isNumber(tok) {
  return /^-?\d+(\.\d+)?$/.test(tok);
}

function baseOp(text) {
  return {
    'نوع_العملية': null,
    'التاريخ': null, // يحقنه الـ workflow (تاريخ اليوم بتوقيت TIMEZONE)
    'المبلغ': null,
    'العملة': 'شيكل',
    'الحساب': null,
    'الحساب_المقابل': null,
    'المنفّذ': 'أنا',
    'الاتجاه': null,
    'الموقع': null,
    'نوع_التجديد': null,
    'اسم_العميل': null,
    'معرف_الاشتراك': null,
    'البند': null,
    'التصنيف': null,
    'نص_الملاحظة': null,
    'الثقة': 1,
    'يحتاج_توضيح': false,
    'سؤال_التوضيح': null,
    'النص_الأصلي': text,
  };
}

function ask(op, question) {
  op['يحتاج_توضيح'] = true;
  op['سؤال_التوضيح'] = question;
  return { matched: true, op };
}

/** يبني قواميس بحث مطبَّعة من الإعدادات */
function buildLookups(config) {
  const acc = {};
  for (const [k, v] of Object.entries(config.accounts)) acc[normalize(k)] = v;
  const dests = {};
  for (const [k, v] of Object.entries(config.dests)) dests[normalize(k)] = v;
  const chips = {};
  for (const [k, v] of Object.entries(config.chips)) chips[normalize(k)] = v;
  const sites = {};
  for (const s of config.sites) sites[normalize(s)] = s;
  return { acc, dests, chips, sites };
}

function accountCurrency(config, account) {
  return (config.accountCurrencies && config.accountCurrencies[account]) || 'شيكل';
}

function shortcutHelp(config) {
  return `الحساب غير معروف. الاختصارات المتاحة: ${Object.keys(config.accounts).join(' · ')}`;
}

/** يلتقط المدة من المصفوفة ويعيد [المدة أو null, مؤشرات التوكنات المستهلكة]
 *  الصيغ: شهر · 3 شهور · ش (=شهر) · 3ش أو 3 ش (=3 شهور) */
function extractDuration(toks) {
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === 'شهر') return ['شهر', [i]];
    if ((toks[i] === 'شهور' || toks[i] === 'ش') && i > 0 && isNumber(toks[i - 1])) {
      return [toks[i - 1] === '1' ? 'شهر' : `${toks[i - 1]} شهور`, [i - 1, i]];
    }
    if (toks[i] === 'ش') return ['شهر', [i]];
    const m = toks[i].match(/^(\d+)ش$/);
    if (m) return [m[1] === '1' ? 'شهر' : `${m[1]} شهور`, [i]];
  }
  return [null, []];
}

/** يلتقط الشريحة (مع التهام «موبايل» بعد «هوت») */
function extractChip(toks, chips) {
  for (let i = 0; i < toks.length; i++) {
    if (chips[toks[i]]) {
      const used = [i];
      if (toks[i] === 'هوت' && toks[i + 1] === 'موبايل') used.push(i + 1);
      return [chips[toks[i]], used];
    }
  }
  return [null, []];
}

function extractSite(toks, sites) {
  for (let i = 0; i < toks.length; i++) if (sites[toks[i]]) return [sites[toks[i]], [i]];
  return [null, []];
}

function leftoverText(rawToks, usedIdx) {
  const used = new Set(usedIdx);
  const rest = rawToks.filter((_, i) => !used.has(i));
  return rest.length ? rest.join(' ') : null;
}

function parseLine(rawLine, config, lk) {
  const text = rawLine.trim();
  const rawToks = text.split(/\s+/);
  const toks = rawToks.map(normalize);
  const head = toks[0];

  // ملاحظة <نص حر — يُحفظ حرفياً من النص الأصلي>
  if (head === 'ملاحظه' || (head === 'ضيف' && toks[1] === 'ملاحظه')) {
    const skip = head === 'ضيف' ? 2 : 1;
    const note = rawToks.slice(skip).join(' ');
    const op = baseOp(text);
    op['نوع_العملية'] = 'ملاحظة';
    if (!note) return ask(op, 'ما نص الملاحظة؟');
    op['نص_الملاحظة'] = note;
    return { matched: true, op };
  }

  // مطابقة <موقع> <الرصيد الفعلي ±>
  if (head === 'مطابقه') {
    const op = baseOp(text);
    op['نوع_العملية'] = 'تسوية_مطابقة';
    const site = lk.sites[toks[1]];
    const num = toks.slice(2).find(isNumber);
    if (!site) return ask(op, `أي موقع؟ المواقع: ${config.sites.join(' · ')}`);
    if (num === undefined) return ask(op, 'ما الرصيد الفعلي الظاهر على الموقع؟ (قد يكون سالباً لليان)');
    op['الموقع'] = site;
    op['المبلغ'] = parseFloat(num);
    op._derived = { confirmRequired: true }; // تثبيت التسوية وحده خلف تأكيد
    return { matched: true, op };
  }

  // سدد <مبلغ> <حساب> — تسديد من أبو حسام
  if (head === 'سدد') {
    const op = baseOp(text);
    op['نوع_العملية'] = 'تسديد';
    op['الاتجاه'] = 'وارد';
    op['المنفّذ'] = config.executorName || 'أبو حسام';
    const rest = toks.slice(1).filter((t) => !FILLERS.has(t));
    const num = rest.find(isNumber);
    const accTok = rest.find((t) => lk.acc[t]);
    if (num === undefined) return ask(op, 'كم المبلغ المسدَّد؟');
    if (!accTok) return ask(op, `على أي حساب استلمت التسديد؟ ${shortcutHelp(config)}`);
    op['المبلغ'] = parseFloat(num);
    op['الحساب'] = lk.acc[accTok];
    op['التصنيف'] = 'تسديد من منفّذ';
    return { matched: true, op };
  }

  // شحن <موقع> <مبلغ> <حساب>
  if (head === 'شحن') {
    const op = baseOp(text);
    op['نوع_العملية'] = 'شحن_رصيد';
    op['الاتجاه'] = 'صادر';
    const rest = toks.slice(1).filter((t) => !FILLERS.has(t));
    const siteTok = rest.find((t) => lk.sites[t]);
    const num = rest.find(isNumber);
    const accTok = rest.find((t) => lk.acc[t]);
    if (!siteTok) return ask(op, `أي موقع تشحن؟ المواقع: ${config.sites.join(' · ')}`);
    if (num === undefined) return ask(op, 'كم مبلغ الشحن؟');
    if (!accTok) return ask(op, `من أي حساب دفعت؟ ${shortcutHelp(config)}`);
    op['الموقع'] = lk.sites[siteTok];
    op['المبلغ'] = parseFloat(num);
    op['الحساب'] = lk.acc[accTok];
    op['التصنيف'] = 'شحن رصيد موقع';
    return { matched: true, op };
  }

  // حول <حساب1> <حساب2> <مبلغ> — تحويل داخلي بالشيكل
  if (head === 'حول') {
    const op = baseOp(text);
    op['نوع_العملية'] = 'تحويل_داخلي';
    const rest = toks.slice(1).filter((t) => !FILLERS.has(t));
    const accToks = rest.filter((t) => lk.acc[t]);
    const num = rest.find(isNumber);
    if (accToks.length !== 2) return ask(op, `التحويل يحتاج حسابين. ${shortcutHelp(config)}`);
    if (num === undefined) return ask(op, 'كم المبلغ المحوَّل؟');
    const from = lk.acc[accToks[0]];
    const to = lk.acc[accToks[1]];
    if (accountCurrency(config, from) !== accountCurrency(config, to)) {
      return ask(op, 'التحويل من/إلى بايننس يغيّر العملة — استعمل: «شراء بايننس <كمية> <حساب الدفع>»');
    }
    op['الحساب'] = from;
    op['الحساب_المقابل'] = to;
    op['المبلغ'] = parseFloat(num);
    op['الاتجاه'] = 'صادر';
    op['التصنيف'] = 'تحويل بين الحسابات';
    return { matched: true, op };
  }

  // شراء بايننس <كمية USDT> <حساب الدفع>
  if (head === 'شراء') {
    const op = baseOp(text);
    op['نوع_العملية'] = 'شراء_USDT';
    op['العملة'] = 'USDT';
    const rest = toks.slice(1).filter((t) => !FILLERS.has(t) && t !== 'بايننس' && t !== 'usdt');
    const num = rest.find(isNumber);
    const accTok = rest.find((t) => lk.acc[t] && lk.acc[t] !== config.binanceAccount);
    if (num === undefined) return ask(op, 'كم كمية الـ USDT المشتراة؟');
    if (!accTok) return ask(op, `من أي حساب دفعت الشيكل؟ ${shortcutHelp(config)}`);
    op['المبلغ'] = parseFloat(num);
    op['الحساب'] = config.binanceAccount;
    op['الحساب_المقابل'] = lk.acc[accTok];
    op['الاتجاه'] = 'وارد';
    op['التصنيف'] = 'تحويل بين الحسابات';
    op._derived = { rate: config.fxRate, shekel: parseFloat(num) * config.fxRate };
    return { matched: true, op };
  }

  // <شريحة> <مدة> [موقع] <بيت|اسامة|انس> — تجديد عائلي: التكلفة مصروف على صاحبه وخصم من الموقع، بلا نقد
  if (lk.chips[head]) {
    const op = baseOp(text);
    const [chip] = extractChip(toks, lk.chips);
    const [dur] = extractDuration(toks);
    const [siteName] = extractSite(toks, lk.sites);
    const destIdx = toks.findIndex((t) => lk.dests[t]);
    if (destIdx === -1) {
      return ask(op, 'تجديد لمن؟ أضف الوجهة: بيت أو اسامة أو انس — مثال: وي 1ش الوها انس\n(لو هذا بيع لزبون استعمل: وارد بال 60 ' + rawToks.join(' ') + ')');
    }
    if (!dur) return ask(op, 'ما المدة؟ مثال: وي 1ش الوها انس');
    const saleSite = siteName || config.defaultSite;
    const key = `${chip} - ${dur} - ${saleSite}`;
    let cost = config.pricing[key];
    if ((cost === undefined || cost === null) && saleSite !== config.defaultSite) {
      cost = config.pricing[`${chip} - ${dur} - ${config.defaultSite}`];
    }
    if (cost === undefined || cost === null) {
      return ask(op, `تكلفة «${chip} - ${dur}» غير مُدخلة في جدول التسعير — أدخلها أولاً.`);
    }
    const destSheet = lk.dests[toks[destIdx]];
    op['نوع_العملية'] = 'تجديد_عائلي';
    op['نوع_التجديد'] = key;
    op['الموقع'] = saleSite;
    op['اسم_العميل'] = destSheet.replace('مصاريف ', '');
    op._derived = { cost, chip, dur, expenseType: config.destTypes[destSheet] };
    return { matched: true, op };
  }

  // شريحة <نوع> <مدة> <مبلغ> [حساب] [اسم] — صيغة طبيعية للبيع؛ تُعاد كتابتها كصيغة «وارد»
  if (head === 'شريحه' || head === 'بعت') {
    const restRaw = rawToks.slice(1);
    const restNorm = toks.slice(1);
    const op = baseOp(text);
    const amtIdx = restNorm.findIndex((t, i) => isNumber(t) && restNorm[i + 1] !== 'شهور' && restNorm[i + 1] !== 'ش');
    if (amtIdx === -1) return ask(op, 'كم المبلغ الوارد؟ مثال: شريحة وي 3 شهور 150 بال');
    const accIdx = restNorm.findIndex((t) => lk.acc[t]);
    const [chip, chipUsed] = extractChip(restNorm, lk.chips);
    if (accIdx === -1 || !chip) {
      // سؤال واحد يجمع كل الناقص + سطر جاهز للنسخ والتعديل
      const [dur, durUsed] = extractDuration(restNorm);
      const [siteName, siteUsed] = extractSite(restNorm, lk.sites);
      const used = new Set([amtIdx, accIdx, ...chipUsed, ...durUsed, ...siteUsed].filter((i) => i >= 0));
      const client = restRaw.filter((_, i) => !used.has(i)).join(' ');
      const parts = ['وارد',
        accIdx === -1 ? '<الحساب>' : restRaw[accIdx],
        restNorm[amtIdx],
        chip ? chipUsed.map((i) => restRaw[i]).join(' ') : '<الشريحة>',
        dur || '<المدة>'];
      if (siteName) parts.push(siteName);
      if (client) parts.push(client);
      const miss = [];
      if (accIdx === -1) miss.push('الحساب المستلم (فلسطين/اسلامي/بال/جوال/كاش/اجل)');
      if (!chip) miss.push('نوع الشريحة (وي/سيليكوم/هوت/بارتنر/بيليفون)');
      return ask(op, 'ناقص: ' + miss.join(' و') + '.\nانسخ السطر وعدّل ما بين <> ثم أرسل:\n' + parts.join(' '));
    }
    const rebuilt = ['وارد', restRaw[accIdx], restNorm[amtIdx], ...restRaw.filter((_, i) => i !== amtIdx && i !== accIdx)].join(' ');
    const res = parseLine(rebuilt, config, lk);
    if (res.op) res.op['النص_الأصلي'] = text;
    return res;
  }

  // كشف <حساب> [مدة: اسبوع | شهر | شهرين | عدد أيام | N شهور] — عرض حركات الحساب
  if (head === 'كشف') {
    const op = baseOp(text);
    op['نوع_العملية'] = 'كشف_حساب';
    const rest = toks.slice(1);
    const accTok = rest.find((t) => lk.acc[t]);
    if (!accTok) return ask(op, 'كشف أي حساب؟ أمثلة: كشف فلسطين شهر · كشف هيئة اسبوع · كشف جوالي 60');
    let days = 30;
    rest.forEach((t, i) => {
      if (t === 'اسبوع') days = 7;
      else if (t === 'شهر') days = 30;
      else if (t === 'شهرين') days = 60;
      else if (isNumber(t) && parseFloat(t) > 0 && parseFloat(t) <= 365) {
        days = rest[i + 1] === 'شهور' ? parseFloat(t) * 30 : parseFloat(t);
      }
    });
    op['الحساب'] = lk.acc[accTok];
    op._derived = { days };
    return { matched: true, op };
  }

  // هيئة <حساب الدفع> <رقم الجوال> <المبلغ> <طالب الخدمة> <نوع الخدمة...> — الترتيب حر
  if (head === 'هيئه') {
    const op = baseOp(text);
    op['نوع_العملية'] = 'خدمة_هيئة';
    const restRaw = rawToks.slice(1);
    const restNorm = toks.slice(1);
    const used = new Set();
    let phone = null; let accIdx = -1;
    restNorm.forEach((t, i) => {
      if (!phone && /^05\d{8}$/.test(t)) { phone = t; used.add(i); return; }
      if (accIdx === -1 && lk.acc[t]) { accIdx = i; used.add(i); }
    });
    let amt = null;
    restNorm.forEach((t, i) => { if (amt === null && !used.has(i) && isNumber(t)) { amt = parseFloat(t); used.add(i); } });
    let seeker = null;
    restNorm.forEach((t, i) => { if (seeker === null && !used.has(i) && !isNumber(t)) { seeker = restRaw[i]; used.add(i); } });
    const service = restRaw.filter((_, i) => !used.has(i)).join(' ') || null;
    if (amt === null) {
      return ask(op, 'ناقص المبلغ.\nالصيغة: هيئة 0590000000 64 خالد فاتورة شهر 7 (الدفع من رصيد جوال تلقائياً، أو اذكر الحساب)');
    }
    // بلا حساب مذكور: الدفع من «رصيد جوال» تلقائياً
    op['الحساب'] = accIdx === -1 ? (config.defaultServiceAccount || 'رصيد جوال') : lk.acc[restNorm[accIdx]];
    op['المبلغ'] = amt;
    op['معرف_الاشتراك'] = phone;
    op['اسم_العميل'] = seeker;
    op['البند'] = service;
    op['الاتجاه'] = 'صادر';
    return { matched: true, op };
  }

  // وارد | صادر <حساب> <مبلغ> <البقية حرة>
  if (head === 'وارد' || head === 'صادر') {
    const op = baseOp(text);
    op['الاتجاه'] = head === 'وارد' ? 'وارد' : 'صادر';
    const accTok = toks[1];
    if (!accTok || !lk.acc[accTok]) {
      return ask(op, shortcutHelp(config));
    }
    op['الحساب'] = lk.acc[accTok];
    op['العملة'] = accountCurrency(config, op['الحساب']);
    if (!toks[2] || !isNumber(toks[2])) return ask(op, 'كم المبلغ؟ الصيغة: وارد/صادر <الحساب> <المبلغ> …');
    op['المبلغ'] = parseFloat(toks[2]);
    if (op['المبلغ'] <= 0) return ask(op, 'المبلغ يجب أن يكون أكبر من صفر.');

    const restIdx = [];
    for (let i = 3; i < toks.length; i++) restIdx.push(i);
    const rest = restIdx.map((i) => toks[i]);

    // ترحيل في أي موضع ← صفحة الترحيل والنص محفوظ حرفياً
    if (rest.includes('ترحيل')) {
      op['نوع_العملية'] = 'حركة_عامة';
      op['التصنيف'] = 'ترحيل';
      op['البند'] = leftoverText(rawToks, [0, 1, 2]);
      op._derived = { route: 'حركات للترحيل' };
      return { matched: true, op };
    }

    // وجهة مصروف: بيت / اسامة / انس
    const destIdx = restIdx.find((i) => lk.dests[toks[i]]);
    if (destIdx !== undefined) {
      if (op['الاتجاه'] !== 'صادر') return ask(op, 'مصروف باتجاه وارد؟ وضّح العملية.');
      op['نوع_العملية'] = config.destTypes[lk.dests[toks[destIdx]]];
      op['البند'] = leftoverText(rawToks, [0, 1, 2, destIdx]);
      return { matched: true, op };
    }

    // بيع شريحة بلاستيك من المخزون
    const plasticIdx = restIdx.find((i) => toks[i] === 'بلاستيك');
    if (plasticIdx !== undefined) {
      const [chip, chipUsed] = extractChip(rest, lk.chips);
      if (!chip) return ask(op, `أي نوع بلاستيك؟ الأنواع: ${Object.values(config.chips).join(' · ')}`);
      const key = `${chip} - بلاستيك - مخزون`;
      const cost = config.pricing[key];
      if (cost === undefined || cost === null) {
        return ask(op, `تكلفة «${key}» غير مُدخلة في جدول التسعير — أدخلها أولاً.`);
      }
      op['نوع_العملية'] = 'بيع_بلاستيك';
      op['نوع_التجديد'] = key;
      const usedIdx = [0, 1, 2, plasticIdx, ...chipUsed.map((j) => restIdx[j])];
      op['اسم_العميل'] = leftoverText(rawToks, usedIdx);
      op._derived = { cost, profit: op['المبلغ'] - cost, chip, stock: { chip, delta: -1 } };
      return { matched: true, op };
    }

    // بيع / تجديد: شريحة + مدة (+ موقع اختياري، الافتراضي ليان)
    const [chip, chipUsed] = extractChip(rest, lk.chips);
    const [dur, durUsed] = extractDuration(rest);
    const [site, siteUsed] = extractSite(rest, lk.sites);
    if (chip || dur || site) {
      if (!chip) return ask(op, `أي شريحة؟ الشرائح: ${Object.values(config.chips).join(' · ')}`);
      if (!dur) return ask(op, 'ما المدة؟ شهر أم 3 شهور؟');
      const saleSite = site || config.defaultSite;
      const key = `${chip} - ${dur} - ${saleSite}`;
      let cost = config.pricing[key];
      if ((cost === undefined || cost === null) && saleSite !== config.defaultSite) {
        // التكلفة موحّدة بين المواقع: صف الموقع يغلب إن وُجد، وإلا تكلفة الموقع الافتراضي
        cost = config.pricing[`${chip} - ${dur} - ${config.defaultSite}`];
      }
      if (cost === undefined || cost === null) {
        return ask(op, `تكلفة «${chip} - ${dur}» غير مُدخلة في جدول التسعير — أدخلها أولاً ثم أعد الإرسال.`);
      }
      op['نوع_العملية'] = 'بيع';
      op['نوع_التجديد'] = key;
      op['الموقع'] = saleSite;
      const usedIdx = [0, 1, 2, ...[...chipUsed, ...durUsed, ...siteUsed].map((j) => restIdx[j])];
      op['اسم_العميل'] = leftoverText(rawToks, usedIdx);
      op._derived = { cost, profit: op['المبلغ'] - cost, chip };
      return { matched: true, op };
    }

    // لا شريحة ولا وجهة: حركة عامة على الحساب
    op['نوع_العملية'] = 'حركة_عامة';
    op['البند'] = leftoverText(rawToks, [0, 1, 2]);
    if (op['العملة'] === 'USDT') op._derived = { rate: config.fxRate, shekel: op['المبلغ'] * config.fxRate };
    return { matched: true, op };
  }

  // لا يطابق الصيغة المختصرة ← الطبقة الثانية (النموذج اللغوي)
  return { matched: false, fallback: text };
}

function parseMessage(text, config) {
  const lk = buildLookups(config);
  const lines = stripInvisible(String(text))
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return { lines: lines.map((l) => parseLine(l, config, lk)) };
}

module.exports = { parseMessage, normalize };

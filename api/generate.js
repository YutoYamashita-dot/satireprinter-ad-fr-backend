// backend-vercel/api/generate.js
// 他の箇所は絶対に変えず、以下の点だけ修正：
// ① アプリ指定の言語で必ず出力されるように、リクエストの言語タグを解釈してプロンプトに厳命
// ② フォールバック(localFallback) も同じ言語で返すように拡張
// ③ 出力文章は“必ず書き言葉（文語体・断定調）”になるよう指示文を強化
// ④ モデルAPIを XAI（Grok）に接続
// ⑤ 追加：東京エッジ固定＆上流18秒タイムアウトで 25s 制限内に必ず初期レスポンスを返す

export const config = { runtime: "edge", regions: ["hnd1"] };

// ★ XAI（Grok）用
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const XAI_MODEL   = process.env.XAI_MODEL || "grok-4-fast-reasoning";

// ★ 追加：上流保険タイムアウト（18s）
const UPSTREAM_TIMEOUT_MS = 18_000;
async function callModelWithTimeout(reqBody, url, headers) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("upstream timeout")), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
      signal: ac.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return json({ error: "Only POST" }, 405);
    }
    const body = await req.json().catch(() => ({}));
    const rawWord = String(body?.word ?? "").trim();
    if (!rawWord) return json({ error: "word is required" }, 400);

    // === 追加: アプリ指定の言語（言語タグ）を解釈 ===
    // 受け取り先候補: body.lang / body.language / body.locale
    // 例: "ja", "en", "zh-rCN", "zh-rTW", "es", ...
    const rawLang = String(body?.lang ?? body?.language ?? body?.mode ?? body?.screen ?? body?.locale ?? "").trim();
    const langTag = normalizeLangTag(rawLang || "ja"); // デフォルト: 日本語
    const langLine = languageStrictLine(langTag);      // 「この言語で必ず出力」の厳命文
    const langName = languageName(langTag);            // 人間可読名（例: 日本語, English）

    // ★ 長さモード決定（button から body.length / "short"|"long"）
    //    互換のため、word に "(短め" / "(長め" が含まれていたらそれも解釈
    let lengthMode = String(body?.length ?? "").toLowerCase(); // "short" | "long" | ""
    if (!lengthMode) {
      if (/\(短め/.test(rawWord)) lengthMode = "short";
      else if (/\(長め/.test(rawWord)) lengthMode = "long";
    }
    // デフォルトは “少し長め” の独白調に
    if (lengthMode !== "short" && lengthMode !== "long") {
      lengthMode = "long";
    }

    // ★ スタイル（画面）決定：printer/smile
    let styleMode = String(body?.style ?? body?.screen ?? body?.mode ?? "").toLowerCase(); // "printer" | "smile" | ""
    if (!styleMode) {
      // ▼ 正規表現の文字クラスでの ] / ) をエスケープ（構文エラー修正）
      if (/[[(（]?\s*プリンター\s*[\]\)\）]?/i.test(rawWord) || /\bprinter\b/i.test(rawWord)) {
        styleMode = "printer";
      } else if (/[[(（]?\s*スマイル\s*[\]\)\）]?/i.test(rawWord) || /\bsmile\b/i.test(rawWord)) {
        styleMode = "smile";
      }
    }
    if (!styleMode) {
      styleMode = (lengthMode === "short") ? "printer" : "smile"; // 互換デフォルト
    }

    // 実際にモデルへ渡す「言葉」から、表示用注記は取り除く（長さ・画面タグの痕跡も除去）
    const word = rawWord
      .replace(/\s*\((短め|長め)[^)]*\)\s*$/, "")
      // ▼ 正規表現の文字クラス終端の ] をエスケープ（構文エラー修正）
      .replace(/[\[\(（]\s*(プリンター|スマイル|printer|smile)\s*[\]\)\）]/ig, "")
      .trim();

    if (!XAI_API_KEY) {
      return json(localFallback(word, lengthMode, styleMode, langTag));
    }

    // ★ 長さ制約
    const lengthRule = lengthMode === "short"
      ? "短め（14〜30文字）"
      : "長め（30〜70文字）";

    // === スタイル定義（長さと独立） ===
    // ★ 必ず書き言葉（文語体・断定調）で、会話口調・相づち・感嘆語を禁止
    const styleLine =
      "スタイル＝書き言葉。";

    // === プロンプト（言語厳守をsystemにも明記） ===
    const systemMsg =
      "You must always write the answer in the application-specified language. " +
      `LANG=${langTag}. ` +
      "Return JSON only. Avoid hate speech, slurs, doxxing.";

    const userMsg =
`${langLine}
次の「言葉」について、${lengthRule}の鋭く辛辣で、だが、意外性と納得感があり面白い風刺/皮肉を${langName}で作成すること。難解語は避け、**必ず書き言葉で出力すること**。喋り言葉・会話調・独白は禁止。
${styleLine}
追加要件:
- 固有名は一般語に言い換え（必要なときのみ）
- 出力は**次のJSONのみ**（前後に何も書かない）
{"satire":"…","type":"…"}
- "satire": 1行か2行（スタイルルールに厳密に従う）
- "type": 社会風刺/仕事風刺/恋愛風刺/テクノロジー風刺 など1語
言葉: ${word}`;

    // ★ XAI Grok へ —— 18秒の保険タイムアウトを付与
    let r;
    try {
      r = await callModelWithTimeout(
        {
          model: XAI_MODEL,
          messages: [
            { role: "system", content: systemMsg },
            { role: "user",   content: userMsg }
          ],
          // （オプション）初期応答を早めたい場合は max_output_tokens を控えめに
          // max_output_tokens: 140
        },
        "https://api.x.ai/v1/chat/completions",
        {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${XAI_API_KEY}`
        }
      );
    } catch (e) {
      // タイムアウトやネットワーク障害は即フォールバック
      return json({ ...localFallback(word, lengthMode, styleMode, langTag), error: String(e?.message || e) });
    }

    if (!r.ok) {
      const text = await r.text();
      return json({ ...localFallback(word, lengthMode, styleMode, langTag), error: `XAI ${r.status}: ${text}` });
    }

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {};
    }
    const satire = String(parsed?.satire ?? "").trim();
    const type   = String(parsed?.type   ?? languageTypeDefault(langTag)).trim();

    if (!satire) {
      return json(localFallback(word, lengthMode, styleMode, langTag));
    }

    return json({ satire, type });
  } catch (e) {
    return json({ ...localFallback("", "long", "smile", "ja"), error: String(e?.message || e) }, 200);
  }
}


// ==============================
// 追加: 言語関連の補助関数
// ==============================

function normalizeLangTag(tag) {
  const t = String(tag || "").replace('_','-').trim();
  // 既知タグのみそのまま。未指定は en
  const known = new Set([
    "ja","en","zh-rCN","zh-rTW","es","fr","pt","de","ko",
    "hi","id","tr","ru","bn","sw","ar","mr","te","ta","vi"
  ]);
  if (known.has(t)) return t;
  // 一般的な略記の正規化
  if (/^zh(?:-(?:Hans|CN))?$/i.test(t)) return "zh-rCN";
  if (/^zh-(?:Hant|TW|HK)$/i.test(t))   return "zh-rTW";
  return "en";
}

function languageName(langTag) {
  switch (langTag) {
    case "en": return "English";
    case "zh-rCN": return "简体中文";
    case "zh-rTW": return "繁體中文";
    case "es": return "Español";
    case "fr": return "Français";
    case "pt": return "Português";
    case "de": return "Deutsch";
    case "ko": return "한국어";
    case "hi": return "हिन्दी";
    case "id": return "Bahasa Indonesia";
    case "tr": return "Türkçe";
    case "ru": return "Русский";
    case "ar": return "العربية";
    case "bn": return "বাংলা";
    case "sw": return "Kiswahili";
    case "mr": return "मराठी";
    case "te": return "తెలుగు";
    case "ta": return "தமிழ்";
    case "vi": return "Tiếng Việt";
    case "ja": return "日本語";
    default: return "English";
  }
}

// 「この言語で必ず出力せよ」の厳命（モデルに強く指示）
function languageStrictLine(langTag) {
  const name = languageName(langTag);
  return `【重要】出力言語はアプリ指定の「${name}」（LANG=${langTag}）のみ。必ず ${name} で書き、他言語を混在させないこと。`;
}

function languageTypeDefault(langTag) {
  switch (langTag) {
    case "en": return "Social satire";
    case "zh-rCN": return "社会讽刺";
    case "zh-rTW": return "社會諷刺";
    case "es": return "Sátira social";
    case "fr": return "Satire sociale";
    case "pt": return "Sátira social";
    case "de": return "Gesellschaftssatire";
    case "ko": return "사회 풍자";
    case "hi": return "सामाजिक व्यंग्य";
    case "id": return "Satir sosial";
    case "tr": return "Toplumsal hiciv";
    case "ru": return "Социальная сатирa";
    case "ar": return "سخرية اجتماعية";
    case "bn": return "সামাজিক ব্যঙ্গ";
    case "sw": return "Udhihaka wa kijamii";
    case "mr": return "सामाजिक उपहास";
    case "te": return "సామాజిక వ్యంగ్యం";
    case "ta": return "சமூக கிண்டல்";
    case "vi": return "Châm biếm xã hội";
    case "ja": return "社会風刺";
    default: return "Social satire";
  }
}

// ==============================
// 変更: フォールバックも言語別で返す
// ==============================
function localFallback(w, lengthMode = "long", styleMode = "auto", langTag = "ja") {
  const word = String(w || "").trim() || pickWord(langTag);
  const long = lengthMode === "long";

  // 言語別の簡潔な断定文テンプレ（書き言葉・断定調）
  const T = templates(langTag, word);
  const arr = long ? T.long : T.short;
  const satire = arr[Math.floor(Math.random() * arr.length)];

  let type = languageTypeDefault(langTag);
  const lower = word.toLowerCase();
  if (lower.includes("ai")) type = typeByLang(langTag, "tech");
  else if (word.includes("上司") || /boss|chef|jefe|主管|经理|manager/i.test(word)) type = typeByLang(langTag, "work");
  else if (/恋|愛|love|amor|amour|사랑|любов/i.test(word)) type = typeByLang(langTag, "love");

  return { satire, type };
}

function pickWord(langTag) {
  switch (langTag) {
    case "en": return "it";
    case "zh-rCN": return "它";
    case "zh-rTW": return "它";
    case "es": return "eso";
    case "fr": return "cela";
    case "pt": return "isso";
    case "de": return "das";
    case "ko": return "그것";
    case "hi": return "यह";
    case "id": return "itu";
    case "tr": return "bu";
    case "ru": return "это";
    case "ar": return "ذلك";
    case "bn": return "ওটা";
    case "sw": return "hicho";
    case "mr": return "ते";
    case "te": return "అది";
    case "ta": return "அது";
    case "vi": return "điều đó";
    case "ja": return "それ";
    default: return "it";
  }
}

function typeByLang(langTag, kind) {
  const map = {
    tech: {
      ja:"テクノロジー風刺", en:"Tech satire", zhHans:"科技讽刺", zhHant:"科技諷刺", es:"Sátira tecnológica",
      fr:"Satire technologique", pt:"Sátira tecnológica", de:"Technik-Satire", ko:"기술 풍자",
      hi:"टेक व्यंग्य", id:"Satir teknologi", tr:"Teknoloji hicvi", ru:"Технологическая сатира",
      ar:"سخرية تقنية", bn:"প্রযুক্তি ব্যঙ্গ", sw:"Udhihaka wa teknolojia", mr:"तंत्रज्ञानावर उपहास",
      te:"సాంకేతిక వ్యంగ్యం", ta:"தொழில்நுட்ப கிண்டல்", vi:"Châm biếm công nghệ"
    },
    work: {
      ja:"仕事風刺", en:"Work satire", zhHans:"职场讽刺", zhHant:"職場諷刺", es:"Sátira laboral",
      fr:"Satire du travail", pt:"Sátira de trabalho", de:"Arbeits-Satire", ko:"직장 풍자",
      hi:"काम पर व्यंग्य", id:"Satir pekerjaan", tr:"İş hicvi", ru:"Сатира о работе",
      ar:"سخرية العمل", bn:"কর্মক্ষেত্র ব্যঙ্গ", sw:"Udhihaka wa kazi", mr:"कामावर उपहास",
      te:"పని పై వ్యంగ్యం", ta:"வேலை கிண்டல்", vi:"Châm biếm công việc"
    },
    love: {
      ja:"恋愛風刺", en:"Love satire", zhHans:"爱情讽刺", zhHant:"愛情諷刺", es:"Sátira amorosa",
      fr:"Satire amoureuse", pt:"Sátira de amor", de:"Liebes-Satire", ko:"연애 풍자",
      hi:"प्रेम व्यंग्य", id:"Satir cinta", tr:"Aşk hicvi", ru:"Сатира о любви",
      ar:"سخرية الحب", bn:"ভালোবাসার ব্যঙ্গ", sw:"Udhihaka wa mapenzi", mr:"प्रेमावर उपहास",
      te:"ప్రేమ వ్యంగ్యం", ta:"காதல் கிண்டல்", vi:"Châm biếm tình yêu"
    }
  };
  const key = kind === "tech" ? "tech" : kind === "work" ? "work" : "love";
  const langKey = langTag === "zh-rCN" ? "zhHans" : langTag === "zh-rTW" ? "zhHant" : langTag;
  return (map[key][langKey] ?? languageTypeDefault(langTag));
}

function templates(langTag, w) {
  switch (langTag) {
    case "en": return {
      long: [
        `${w} inflates promises while starving substance.`,
        `${w} is a substitute for certainty that obscures accountability.`,
        `${w} delays decisions while costs accumulate.`,
        `${w} is a deadline disguised as hope.`
      ],
      short: [
        `${w} is an excuse.`,
        `${w} exposes the gap.`,
        `${w} is merely a badge.`,
        `${w} thins responsibility.`
      ]
    };
    case "zh-rCN": return {
      long: [
        `${w}只会吹大承诺，稀释实质。`,
        `${w}不过是廉价安慰，顺带模糊责任。`,
        `${w}让决策迟缓，成本却在递增。`,
        `${w}是披着希望外衣的最后期限。`
      ],
      short: [
        `${w}只是借口。`,
        `${w}暴露了落差。`,
        `${w}不过是一个标记。`,
        `${w}稀释了责任。`
      ]
    };
    case "zh-rTW": return {
      long: [
        `${w}只會誇大承諾，掏空實質。`,
        `${w}不過是廉價的撫慰，還把責任弄得模糊。`,
        `${w}拖慢抉擇，成本卻節節上升。`,
        `${w}是披著希望外衣的最後期限。`
      ],
      short: [
        `${w}只是藉口。`,
        `${w}揭示了落差。`,
        `${w}不過是一枚標記。`,
        `${w}稀釋了責任。`
      ]
    };
    case "es": return {
      long: [
        `${w} infla promesas y adelgaza el fondo.`,
        `${w} no es más que un calmante que difumina la responsabilidad.`,
        `${w} retrasa la decisión mientras el coste crece.`,
        `${w} es un plazo disfrazado de esperanza.`
      ],
      short: [
        `${w} es una excusa.`,
        `${w} deja al descubierto la brecha.`,
        `${w} no es más que una insignia.`,
        `${w} diluye la responsabilidad.`
      ]
    };
    case "fr": return {
      long: [
        `${w} gonfle les promesses et affaiblit le fond.`,
        `${w} n’est qu’un palliatif qui brouille la responsabilité.`,
        `${w} retarde la décision tandis que le coût grimpe.`,
        `${w} est une échéance travestie en espoir.`
      ],
      short: [
        `${w} est une excuse.`,
        `${w} met l’écart à nu.`,
        `${w} n’est qu’un insigne.`,
        `${w} dilue la responsabilité.`
      ]
    };
    case "pt": return {
      long: [
        `${w} incha promessas e esvazia o conteúdo.`,
        `${w} é apenas um anestésico que turva a responsabilidade.`,
        `${w} adia decisões enquanto os custos crescem.`,
        `${w} é um prazo fantasiado de esperança.`
      ],
      short: [
        `${w} é um pretexto.`,
        `${w} expõe a distância.`,
        `${w} é só um emblema.`,
        `${w} dilui a responsabilidade.`
      ]
    };
    case "de": return {
      long: [
        `${w} bläht Versprechen auf und dünnt den Kern aus.`,
        `${w} ist ein billiges Beruhigungsmittel, das Verantwortung verwischt.`,
        `${w} verzögert Entscheidungen, während die Kosten steigen.`,
        `${w} ist eine Frist im Gewand der Hoffnung.`
      ],
      short: [
        `${w} ist ein Vorwand.`,
        `${w} legt die Kluft offen.`,
        `${w} ist nur ein Abzeichen.`,
        `${w} verdünnt die Verantwortung.`
      ]
    };
    case "ko": return {
      long: [
        `${w}는 약속만 부풀리고 실질을 소모한다.`,
        `${w}는 책임을 흐리는 값싼 진정제다.`,
        `${w}는 결정을 지연시키고 비용만 키운다.`,
        `${w}는 희망을 걸친 마감일이다.`
      ],
      short: [
        `${w}는 변명에 불과하다.`,
        `${w}는 간극을 드러낸다.`,
        `${w}는 그저 표식일 뿐이다.`,
        `${w}는 책임을 희석한다.`
      ]
    };
    case "hi": return {
      long: [
        `${w} वादे फुलवतो आणि आशय रिकामा करतो।`,
        `${w} जबाबदारी धूसर करणारा स्वस्त दिलासा आहे।`,
        `${w} निर्णय लांबवतो आणि खर्च वाढवतो।`,
        `${w} आशेचे आवरण चढवलेली अंतिम मुदत आहे।`
      ],
      short: [
        `${w} हा केवळ बहाणा आहे।`,
        `${w} तफावत उघड करते।`,
        `${w} ही फक्त खूण आहे।`,
        `${w} जबाबदारी पातळ करते।`
      ]
    };
    case "id": return {
      long: [
        `${w} membesar-besarkan janji dan mengosongkan substansi.`,
        `${w} hanyalah penenang murah yang mengaburkan tanggung jawab.`,
        `${w} menunda keputusan sementara biaya membengkak.`,
        `${w} adalah tenggat yang menyaru sebagai harapan.`
      ],
      short: [
        `${w} hanyalah alasan.`,
        `${w} menyingkap kesenjangan.`,
        `${w} sekadar lencana.`,
        `${w} mengencerkan tanggung jawab.`
      ]
    };
    case "tr": return {
      long: [
        `${w} vaatleri şişirir, özü zayıflatır.`,
        `${w} sorumluluğu bulanıklaştıran ucuz bir tesellidir.`,
        `${w} kararları erteler, maliyetleri artırır.`,
        `${w} umut kılığına girmiş son tarih olur.`
      ],
      short: [
        `${w} bir mazerettir.`,
        `${w} uçurumu açığa çıkarır.`,
        `${w} sadece bir nişandır.`,
        `${w} sorumluluğu seyreltir.`
      ]
    };
    case "ru": return {
      long: [
        `${w} раздувает обещания и истощает содержание.`,
        `${w} — дешёвое успокоительное, размывающее ответственность.`,
        `${w} тормозит решения, пока растут издержки.`,
        `${w} — срок, замаскированный под надежду.`
      ],
      short: [
        `${w} — это отговорка.`,
        `${w} обнажает разрыв.`,
        `${w} — лишь знак отличия.`,
        `${w} размывает ответственность.`
      ]
    };
    case "ar": return {
      long: [
        `${w} ينفخ الوعود ويفرغ المضمون.`,
        `${w} مسكّن رخيص يطمس المسؤولية.`,
        `${w} يؤخر الحسم فيما تتزايد التكلفة.`,
        `${w} موعد نهائي متنكر بزي الأمل.`
      ],
      short: [
        `${w} ذريعة لا غير.`,
        `${w} يفضح الفجوة.`,
        `${w} مجرد شارة.`,
        `${w} يميع المسؤولية.`
      ]
    };
    case "bn": return {
      long: [
        `${w} প্রতিশ্রুতি ফোলায় এবং মর্মশূন্য করে।`,
        `${w} দায় ঝাপসা করা সস্তা সান্ত্বনা।`,
        `${w} সিদ্ধান্ত পিছোয়, ব্যয় বাড়तो।`,
        `${w} আশার মুখোশ পরা সময়সীমা।`
      ],
      short: [
        `${w} নিছক অজুহাত।`,
        `${w} ফারাক উন্মোচিত হয়।`,
        `${w} কেবল একটি প্রতীক।`,
        `${w} দায় হালকা হয়।`
      ]
    };
    case "sw": return {
      long: [
        `${w} huongeza matumaini na hupunguza kiini.`,
        `${w} ni dawa ya bei rahisi inayoficha uwajibikaji.`,
        `${w} huchelewesha maamuzi huku gharama zikiongezeka.`,
        `${w} ni mwisho uliojifanya tumaini.`
      ],
      short: [
        `${w} ni kisingizio.`,
        `${w} hufichua pengo.`,
        `${w} ni beji tu.`,
        `${w} hupunguza uwajibikaji.`
      ]
    };
    case "mr": return {
      long: [
        `${w} अपेक्षा फुगवते आणि आशय क्षीण करते।`,
        `${w} जबाबदारी धूसर करणारा स्वस्त दिलासा आहे।`,
        `${w} निर्णय विलंबित होतो आणि खर्च वाढतो।`,
        `${w} आशेच्या आवरणातील अंतिम मुदत आहे।`
      ],
      short: [
        `${w} हा फक्त बहाणा आहे।`,
        `${w} दरी उघड होते।`,
        `${w} हा फक्त खूण आहे।`,
        `${w} जबाबदारी पातळ होते।`
      ]
    };
    case "te": return {
      long: [
        `${w} హామీలను ఊదేస్తుంది మరియు సారాన్ని తగ్గిస్తుంది।`,
        `${w} బాధ్యతను మసకబార్చే చవక నెమ్మది।`,
        `${w} నిర్ణయం ఆలస్యం అవుతుంది, ఖర్చు పెరుగుతుంది।`,
        `${w} ఆశ అనే వేషం వేసుకున్న గడువు కాలం।`
      ],
      short: [
        `${w} ఇదొక కారణం మాత్రమే।`,
        `${w} అంతరాన్ని బహిర్గతం చేస్తుంది।`,
        `${w} ఇది కేవలం ఒక గుర్తు।`,
        `${w} ఇది బాధ్యతను పలుచబరుస్తుంది।`
      ]
    };
    case "ta": return {
      long: [
        `${w} வாக்குறுதியை ஊதிவிட்டு உள்ளடக்கத்தை மெலிதாக்குகிறது।`,
        `${w} பொறுப்பை மங்கச் செய்யும் மலிவான ஆறுதல்।`,
        `${w} தீர்மானத்தை தள்ளி செலவு மட்டுமே அதிகரிக்கிறது।`,
        `${w} நம்பிக்கையின் முகமூடியில் மறைந்துள்ள கடைசி நாள்।`
      ],
      short: [
        `${w} ஒரு காரணம் மட்டுமே।`,
        `${w} இடைவெளியை வெளிப்படுத்துகிறது।`,
        `${w} வெறும் அடையாளம்।`,
        `${w} பொறுப்பை மந்தப்படுத்துகிறது।`
      ]
    };
    case "vi": return {
      long: [
        `${w} phóng đại lời hứa và làm rỗng ruột nội dung.`,
        `${w} chỉ là liều xoa dịu rẻ tiền làm mờ trách nhiệm.`,
        `${w} trì hoãn quyết định trong khi chi phí phình to.`,
        `${w} là thời hạn khoác áo hy vọng.`
      ],
      short: [
        `${w} chỉ là cái cớ.`,
        `${w} phơi bày khoảng trống.`,
        `${w} chỉ là một phù hiệu.`,
        `${w} làm loãng trách nhiệm.`
      ]
    };
    case "ja": return {
      long: [
        `${w} 約束を膨らませて中身を痩せさせる。`,
        `${w} 責任の所在を曖昧にする安易な方便である。`,
        `${w} を唱えるほど決断は遅れ、費用だけが積み上がる。`,
        `${w} は希望の衣をまとった締切である。`
      ],
      short: [
        `${w} それは単なる口実である。`,
        `${w} それは齟齬を露わにする。`,
        `${w} それは記章に過ぎない。`,
        `${w} それは責任を希釈する。`
      ]
    };
    default:
      return {
        long: [
         `${w} inflates promises while starving substance.`,
         `${w} is a substitute for certainty that obscures accountability.`,
         `${w} delays decisions while costs accumulate.`,
         `${w} is a deadline disguised as hope.`
        ],
        short: [
          `${w} is an excuse.`,
          `${w} exposes the gap.`,
          `${w} is merely a badge.`,
          `${w} thins responsibility.`
        ]
      };
  }
}


// ==============================
// 共通レスポンス
// ==============================
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
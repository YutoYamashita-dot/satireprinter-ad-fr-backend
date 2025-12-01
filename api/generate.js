// backend-vercel/api/generate.js
// 他の箇所は絶対に変えず、以下の点だけ修正：
// ① アプリ指定の言語で必ず出力されるように、リクエストの言語タグを解釈してプロンプトに厳命
// ② フォールバック(localFallback) も同じ言語で返すように拡張 → 言語別フォールバックは廃止し、共通の簡易メッセージに変更
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
- まず「候補A」として${lengthRule}の文章を1本作り、それを「60点」の出来だとみなす。
- 次に候補Aを素材に、意外性が増し、少しヒヤヒヤするが危険性はなく、納得感のある「候補B（100点）」へと推敲する。
- さらに候補Bを「60点」とみなし、意外性と納得感、笑いの要素が最大になるようにもう一段階推敲し、「最終案（100点）」へと仕上げる。
- JSONの"satire"には、この「最終案」の文章のみを1行または2行で入れること（候補A・候補B・思考プロセスなどは一切出力しない）。
- 固有名は一般語に言い換え（必要なときのみ）
- 出力は**次のJSONのみ**（前後に何も書かない）
{"satire":"…","type":"…"}
- "satire": 1行か2行（スタイルルールに厳密に従う）
- "type": 社会風刺/仕事風刺/恋愛風刺/テクノロジー風刺 など1語
- 差別的表現、個人攻撃、暴力や犯罪を扇動する内容は避け、少しヒヤヒヤしても現実には無害な範囲の風刺にとどめること。
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
// フォールバック: 言語別テンプレは廃止し、共通の簡易メッセージのみ
// ==============================
function localFallback(w, lengthMode = "long", styleMode = "auto", langTag = "ja") {
  const word = String(w || "").trim() || "それ";
  const long = lengthMode === "long";

  const satire = long
    ? `${word} についての風刺は、今は接続不良の陰でひっそりと待機している。`
    : `${word} はいま風刺の順番待ちである。`;

  const type = languageTypeDefault(langTag);
  return { satire, type };
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

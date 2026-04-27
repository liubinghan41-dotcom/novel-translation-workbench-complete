function parseGlossary(raw) {
  if (Array.isArray(raw)) {
    return raw.map(normalizeTerm).filter(Boolean);
  }
  return String(raw || "")
    .split(/\r?\n/)
    .map((line, index) => parseGlossaryLine(line, index))
    .filter(Boolean);
}

function parseGlossaryLine(line, index = 0) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^(.+?)(?:\s*(?:=>|->|=|：|:)\s*)(.+)$/);
  if (!match) {
    return normalizeTerm({
      id: `term-${index + 1}`,
      source: trimmed,
      target: "",
      note: "",
      category: "term"
    });
  }
  const [, source, rest] = match;
  const parts = rest.split(/\s+#\s+|\s+\/\/\s+/);
  return normalizeTerm({
    id: `term-${index + 1}`,
    source: source.trim(),
    target: (parts[0] || "").trim(),
    note: (parts[1] || "").trim(),
    category: "term"
  });
}

function normalizeTerm(term) {
  if (!term || typeof term !== "object") return null;
  const source = String(term.source || term.input || term.original || term.term || "").trim();
  if (!source) return null;
  const target = String(term.target || term.translation || term.output || "").trim();
  const aliases = Array.isArray(term.aliases)
    ? term.aliases.map(String).map((item) => item.trim()).filter(Boolean)
    : String(term.aliases || "")
        .split(/[|,，、]/)
        .map((item) => item.trim())
        .filter(Boolean);
  return {
    id: term.id || source,
    source,
    target,
    aliases,
    note: String(term.note || term.description || "").trim(),
    category: String(term.category || term.type || "term").trim(),
    matchType: term.matchType || "contains"
  };
}

function termNeedles(term) {
  return [term.source, ...(term.aliases || [])].filter(Boolean);
}

function includesTerm(text, term) {
  const haystack = String(text || "");
  return termNeedles(term).some((needle) => needle && haystack.includes(needle));
}

function relevantTerms(rawGlossary, text, limit = 80) {
  const terms = parseGlossary(rawGlossary);
  const relevant = [];
  for (const term of terms) {
    if (includesTerm(text, term)) relevant.push(term);
    if (relevant.length >= limit) break;
  }
  return relevant;
}

function formatGlossaryTerms(terms) {
  if (!terms || !terms.length) return "无";
  return terms
    .map((term) => {
      const arrow = term.target ? `${term.source} => ${term.target}` : term.source;
      const aliases = term.aliases?.length ? `；别名：${term.aliases.join("、")}` : "";
      const note = term.note ? `；备注：${term.note}` : "";
      return `- ${arrow}${aliases}${note}`;
    })
    .join("\n");
}

function glossaryUsageIssues(rawGlossary, sourceText, translatedText) {
  const terms = relevantTerms(rawGlossary, sourceText, 500);
  const issues = [];
  for (const term of terms) {
    if (!term.target) continue;
    if (!String(translatedText || "").includes(term.target)) {
      issues.push({
        type: "glossary",
        severity: "warning",
        message: `术语「${term.source}」建议译为「${term.target}」，译文中未检测到目标译名。`,
        source: term.source,
        target: term.target
      });
    }
  }
  return issues;
}

module.exports = {
  parseGlossary,
  relevantTerms,
  formatGlossaryTerms,
  glossaryUsageIssues
};

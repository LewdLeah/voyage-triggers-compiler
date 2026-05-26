/**
 * Compiles .js/.mjs trigger files into the single triggers.json blob a Voyage world config expects
 *
 * node voyage-triggers-compiler.mjs <path> [--compact] [--no-mangle] [--no-minify]
 *
 * Mangle (shorten variable names) and minify (strip superfluous whitespace) are both ON by default
 * Pass --no-mangle and/or --no-minify to opt out
 *
 * "path" is a file or folder of top-level .js/.mjs files
 * Files should begin with `export const meta = { name, conditions, effects, recurring, ... }` JSON
 * Everything else in the file becomes the trigger's "script" value
 *
 * Voyage Triggers Compiler 1.0.0 made by LewdLeah on 5/25/2026
 */
"use strict";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, extname, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const isDigit = (c) => ("0" <= c) && (c <= "9");
const isHexDigit = (c) => (
  isDigit(c)
  || (("a" <= c) && (c <= "f"))
  || (("A" <= c) && (c <= "F"))
);
const isOctalDigit = (c) => ("0" <= c) && (c <= "7");
const isBinaryDigit = (c) => (c === "0") || (c === "1");
const isIdentStart = (c) => (
  (("a" <= c) && (c <= "z"))
  || (("A" <= c) && (c <= "Z"))
  || (c === "$")
  || (c === "_")
  || ("\x7f" < c)
);
const isIdentPart = (c) => (isIdentStart(c) || isDigit(c));
const PUNCT_4 = new Set([">>>="]);
const PUNCT_3 = new Set(["===", "!==", ">>>", "<<=", ">>=", "**=", "&&=", "||=", "??=", "..."]);
const PUNCT_2 = new Set([
  "==", "!=", "<=", ">=", "<<", ">>", "**", "++", "--",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
  "&&", "||", "??", "=>", "?."
]);
const PREFIX_DIGITS = {
  x: isHexDigit, X: isHexDigit,
  b: isBinaryDigit, B: isBinaryDigit,
  o: isOctalDigit, O: isOctalDigit
};
const KEYWORDS_EXPECT_EXPR = new Set([
  "return", "typeof", "instanceof", "in", "of", "delete", "void", "new", "throw",
  "yield", "await", "case", "do"
]);
const KEYWORDS_NOT_EXPR_END = new Set([
  "if", "for", "while", "switch", "with",
  "var", "let", "const", "function", "class",
  "else", "try", "catch", "finally", "do"
]);
const NON_REGEX_AFTER_PUNCT = new Set([")", "]", "++", "--"]);
const EXPR_END_PUNCT = new Set([")", "]", "}", "++", "--"]);
const STMT_START_PUNCT = new Set(["{", "(", "[", "+", "-", "!", "~", "++", "--", "..."]);
const RESTRICTED_PROD = new Set(["return", "throw", "yield", "break", "continue", "async"]);
const BLOCK_CONTINUATION = new Set(["else", "catch", "finally", "while"]);
const BLOCK_BEFORE_BRACE_PUNCT = new Set(["=>", ")", ";", "}", "{"]);
const STICKY_FAMILIES = [new Set(["+", "++", "+="]), new Set(["-", "--", "-="])];
const EXPR_CONTINUATION = new Set(["(", "[", "+", "-", "/"]);
const SEMANTIC_CONDITION_TYPES = new Set(["story", "action"]);
const LITERAL_TOKEN_TYPES = new Set(["number", "string", "template", "regex", "private"]);
const ID_LIKE_TOKEN_TYPES = new Set(["ident", "number", "private"]);
const TRIVIA_TOKEN_TYPES = new Set(["ws", "lineComment", "blockComment", "shebang"]);
const REF_ROLES = new Set(["ref", "shorthand-prop"]);
const YIELD_TERMINATORS = new Set([",", ";", ")", "]", "}", ":"]);
const LIMITS = {
  perTriggerCompactJson: 10000,
  conditionsPerTrigger: 5,
  effectsPerTrigger: 5,
  semanticTriggers: 200,
  mechanicalTriggers: 500
};
const isValidIdentifier = (name) => {
  try {
    new Function(`"use strict"; var ${name};`);
    return true;
  } catch {
    return false;
  }
};
const generateMangledName = (idx) => {
  let s = "";
  while (true) {
    s = String.fromCharCode(97 + (idx % 26)) + s;
    if (idx < 26) {
      break;
    }
    idx = Math.floor(idx / 26) - 1;
  }
  return s;
};
const isWhitespace = (c) => ((c === " ") || (c === "\t") || (c === "\r") || (c === "\n"));
const scanLineComment = (source, i) => {
  const end = source.indexOf("\n", i);
  return end === -1 ? source.length : end;
};
const scanBlockComment = (source, i) => {
  const end = source.indexOf("*/", i + 2);
  return end === -1 ? source.length : end + 2;
};
const scanString = (source, i, quote) => {
  i++;
  while (i < source.length) {
    const x = source[i];
    if (x === "\\") {
      i += 2;
    } else if (x === quote) {
      i++;
      break;
    } else if (x === "\n") {
      break;
    } else {
      i++;
    }
  }
  return i;
};
const scanRegex = (source, i) => {
  let inClass = false;
  while (i < source.length) {
    const x = source[i];
    if (x === "\\") {
      i += 2;
    } else if (x === "[") {
      inClass = true;
      i++;
    } else if (x === "]") {
      inClass = false;
      i++;
    } else if ((x === "/") && !inClass) {
      i++;
      break;
    } else if (x === "\n") {
      break;
    } else {
      i++;
    }
  }
  while ((i < source.length) && isIdentPart(source[i])) {
    i++;
  }
  return i;
};
const scanDigitRun = (source, i, predicate) => {
  while ((i < source.length) && (predicate(source[i]) || (source[i] === "_"))) {
    i++;
  }
  return i;
};
const scanTemplate = (source, start) => {
  const interpolationTexts = [];
  let i = start + 1;
  while (i < source.length) {
    const x = source[i];
    if (x === "\\") {
      i += 2;
    } else if (x === "`") {
      return { end: i + 1, interpolationTexts };
    } else if ((x === "$") && (source[i + 1] === "{")) {
      i += 2;
      const interpStart = i;
      let braceDepth = 1;
      let lastSig = "(";
      while ((i < source.length) && (0 < braceDepth)) {
        const y = source[i];
        if (y === "\\") {
          i += 2;
          lastSig = source[i - 1] ?? lastSig;
        } else if ((y === "\"") || (y === "'")) {
          i = scanString(source, i, y);
          lastSig = y;
        } else if (y === "`") {
          i = scanTemplate(source, i).end;
          lastSig = "`";
        } else if ((y === "/") && (source[i + 1] === "/")) {
          i = scanLineComment(source, i);
        } else if ((y === "/") && (source[i + 1] === "*")) {
          i = scanBlockComment(source, i);
        } else if (y === "/") {
          i = (
            NON_REGEX_AFTER_PUNCT.has(lastSig)
            || isIdentPart(lastSig)
            || (lastSig === "\"") || (lastSig === "'") || (lastSig === "`")
          ) ? (i + 1) : scanRegex(source, i + 1);
          lastSig = "/";
        } else if (y === "{") {
          braceDepth++;
          i++;
          lastSig = "{";
        } else if (y === "}") {
          braceDepth--;
          i++;
          if (0 < braceDepth) {
            lastSig = "}";
          }
        } else if (isWhitespace(y)) {
          i++;
        } else {
          i++;
          lastSig = (((y === "+") || (y === "-")) && (lastSig === y)) ? y + y : y;
        }
      }
      // i is now past the closing `}`; interpolation text spans [interpStart, i - 1)
      interpolationTexts.push(source.slice(interpStart, i - 1));
    } else {
      i++;
    }
  }
  return { end: i, interpolationTexts };
};
const tokenize = (source) => {
  const tokens = [];
  let i = 0;
  if (source.startsWith("#!")) {
    const stop = scanLineComment(source, 0);
    tokens.push({ type: "shebang", value: source.slice(0, stop), hasNewline: false, start: 0 });
    i = stop;
  }
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if ((c === "/") && (next === "/")) {
      const stop = scanLineComment(source, i);
      tokens.push({ type: "lineComment", value: source.slice(i, stop), hasNewline: false, start: i });
      i = stop;
      continue;
    } else if ((c === "/") && (next === "*")) {
      const stop = scanBlockComment(source, i);
      const value = source.slice(i, stop);
      tokens.push({ type: "blockComment", value, hasNewline: value.includes("\n"), start: i });
      i = stop;
      continue;
    } else if (isWhitespace(c)) {
      const start = i;
      while ((i < source.length) && isWhitespace(source[i])) {
        i++;
      }
      const value = source.slice(start, i);
      tokens.push({ type: "ws", value, hasNewline: value.includes("\n"), start });
      continue;
    } else if ((c === "\"") || (c === "'")) {
      const start = i;
      i = scanString(source, i, c);
      tokens.push({ type: "string", value: source.slice(start, i), hasNewline: false, start });
      continue;
    } else if (c === "`") {
      const start = i;
      const scan = scanTemplate(source, i);
      i = scan.end;
      const value = source.slice(start, i);
      tokens.push({ type: "template", value, hasNewline: value.includes("\n"), start, interpolationTexts: scan.interpolationTexts });
      continue;
    } else if (c === "/") {
      let last = null;
      for (let j = tokens.length - 1; 0 <= j; j--) {
        const t = tokens[j];
        if (!TRIVIA_TOKEN_TYPES.has(t.type)) {
          last = t;
          break;
        }
      }
      if (
        (last === null)
        || ((last.type === "punct") && !NON_REGEX_AFTER_PUNCT.has(last.value))
        || ((last.type === "ident") && KEYWORDS_EXPECT_EXPR.has(last.value))
      ) {
        const start = i;
        i = scanRegex(source, i + 1);
        tokens.push({ type: "regex", value: source.slice(start, i), hasNewline: false, start });
        continue;
      }
    } else if (isDigit(c) || ((c === ".") && isDigit(next))) {
      const start = i;
      const prefixPred = (c === "0") ? PREFIX_DIGITS[next] : undefined;
      if (prefixPred) {
        i = scanDigitRun(source, i + 2, prefixPred);
      } else {
        i = scanDigitRun(source, i, isDigit);
        if (source[i] === ".") {
          i = scanDigitRun(source, i + 1, isDigit);
        }
        if ((source[i] === "e") || (source[i] === "E")) {
          i++;
          if ((source[i] === "+") || (source[i] === "-")) {
            i++;
          }
          i = scanDigitRun(source, i, isDigit);
        }
      }
      if (source[i] === "n") {
        i++;
      }
      tokens.push({ type: "number", value: source.slice(start, i), hasNewline: false, start });
      continue;
    } else if (isIdentStart(c) || ((c === "\\") && (source[i + 1] === "u"))) {
      const start = i;
      while (i < source.length) {
        const x = source[i];
        if ((x === "\\") && (source[i + 1] === "u")) {
          i += 2;
          if (source[i] === "{") {
            while ((i < source.length) && (source[i] !== "}")) {
              i++;
            }
            if (source[i] === "}") {
              i++;
            }
          } else {
            i += 4;
          }
        } else if (isIdentPart(x)) {
          i++;
        } else {
          break;
        }
      }
      tokens.push({ type: "ident", value: source.slice(start, i), hasNewline: false, start });
      continue;
    } else if (c === "#") {
      const start = i;
      i++;
      while ((i < source.length) && isIdentPart(source[i])) {
        i++;
      }
      tokens.push({ type: "private", value: source.slice(start, i), hasNewline: false, start });
      continue;
    }
    const start = i;
    const four = source.slice(i, i + 4);
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    const match = (
      PUNCT_4.has(four) ? four
      : PUNCT_3.has(three) ? three
      : PUNCT_2.has(two) ? two
      : c
    );
    tokens.push({ type: "punct", value: match, hasNewline: false, start });
    i += match.length;
  }
  return tokens;
};
const needsSpace = (prev, curr) => (
  (ID_LIKE_TOKEN_TYPES.has(prev.type) && ID_LIKE_TOKEN_TYPES.has(curr.type))
  || ((prev.type === "punct") && (curr.type === "punct") && STICKY_FAMILIES.some((f) => f.has(prev.value) && f.has(curr.value)))
);
export const minify = (source) => {
  let output = "";
  let prev = null;
  let crossedNewline = false;
  const braceStack = [];
  let lastBraceWasObject = false;
  for (const tok of tokenize(source)) {
    if (tok.type === "shebang") {
      output += tok.value;
      output += "\n";
      continue;
    } else if (
      (tok.type === "ws")
      || (tok.type === "lineComment")
      || (tok.type === "blockComment")
    ) {
      if (tok.hasNewline) {
        crossedNewline = true;
      }
      continue;
    } else if (prev !== null) {
      const restricted = (prev.type === "ident") && RESTRICTED_PROD.has(prev.value);
      if (
        crossedNewline
        && (
          ((prev.type === "ident") && !KEYWORDS_EXPECT_EXPR.has(prev.value) && !KEYWORDS_NOT_EXPR_END.has(prev.value))
          || LITERAL_TOKEN_TYPES.has(prev.type)
          || ((prev.type === "punct") && EXPR_END_PUNCT.has(prev.value))
          || restricted
        )
        && (
          (tok.type === "ident")
          || LITERAL_TOKEN_TYPES.has(tok.type)
          || ((tok.type === "punct") && STMT_START_PUNCT.has(tok.value))
        )
      ) {
        if (
          (prev.type === "punct") && (prev.value === "}")
          && (tok.type === "ident")
          && BLOCK_CONTINUATION.has(tok.value)
          && ((tok.value !== "while") || !lastBraceWasObject)
        ) {
          if (needsSpace(prev, tok)) {
            output += " ";
          }
        } else if (restricted || !((tok.type === "punct") && EXPR_CONTINUATION.has(tok.value))) {
          output += ";";
        } else if (needsSpace(prev, tok)) {
          output += " ";
        }
      } else if (needsSpace(prev, tok)) {
        output += " ";
      }
    }
    output += tok.value;
    if ((tok.type === "punct") && (tok.value === "{")) {
      braceStack.push(
        (prev !== null) && (
          ((prev.type === "punct") && !BLOCK_BEFORE_BRACE_PUNCT.has(prev.value))
          || ((prev.type === "ident") && (prev.value !== "do") && KEYWORDS_EXPECT_EXPR.has(prev.value))
        )
      );
    } else if ((tok.type === "punct") && (tok.value === "}")) {
      lastBraceWasObject = braceStack.pop() ?? false;
    }
    prev = tok;
    crossedNewline = false;
  }
  return output;
};
// Recursive-descent parser-based mangler
// Never produce semantically-different output
const RESERVED_ALWAYS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "import", "in", "instanceof", "new",
  "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield"
]);
// Reserved as identifiers (binding or reference) in strict mode
// Arguments and eval are intentionally excluded, they have binding restrictions only
const RESERVED_STRICT = new Set([
  "implements", "interface", "let", "package", "private", "protected",
  "public", "static", "yield"
]);
// Property names that, if read off any value, would expose a renamed binding's identity
const REFLECTION_PROP_NAMES = new Set(["name", "constructor", "prototype"]);
// Names that pass isValidIdentifier but break the tokenizer/minifier's regex or ASI heuristics
// 'of' makes a following `/` look like a regex, 'async' is in RESTRICTED_PROD, the rest are contextual keywords
const MANGLER_NAME_BLACKLIST = new Set([
  "of", "async", "let", "static", "get", "set", "from", "as",
  "target", "meta", "arguments", "eval", "yield", "await"
]);
const ASSIGNMENT_OPS = new Set([
  "=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=",
  "&=", "|=", "^=", "&&=", "||=", "??="
]);
const PATTERN_OPEN = new Set(["[", "{"]);
const PROP_NAME_TYPES = new Set(["ident", "string", "number", "private"]);
const MODIFIER_CONTINUATIONS = new Set(["[", "*", "{"]);
const SUPER_FOLLOWERS = new Set([".", "[", "("]);
const FUNCTION_SCOPE_KINDS = new Set(["function", "arrow", "global"]);
const REFUSE_GLOBAL_REFS = new Set(["eval", "Function"]);
export const mangle = (source, { onWarning = () => {} } = {}) => {
  const tokens = tokenize(source);
  const sig = [];
  const sigToTok = [];
  // hasNewlineBeforeSig[i] is true if any trivia (ws/comment) between sig[i-1] and sig[i] contains a newline
  const hasNewlineBeforeSig = [];
  let pendingNewline = false;
  for (const [i, t] of tokens.entries()) {
    if (TRIVIA_TOKEN_TYPES.has(t.type)) {
      pendingNewline ||= t.hasNewline;
      continue;
    }
    sig.push(t);
    sigToTok.push(i);
    hasNewlineBeforeSig.push(pendingNewline);
    pendingNewline = false;
  }
  const renderTokens = () => tokens.map((t) => t.value).join("");
  if (sig.length === 0) {
    return renderTokens();
  }
  // parenMatch[i] = matching ')' index for '(' at sig[i], or -1 for unbalanced; arrow lookahead uses this in O(1)
  const parenMatch = new Array(sig.length).fill(-1);
  const openStack = [];
  for (const [i, t] of sig.entries()) {
    if (t.type !== "punct") {
      continue;
    } else if (t.value === "(") {
      openStack.push(i);
    } else if ((t.value === ")") && (0 < openStack.length)) {
      parenMatch[openStack.pop()] = i;
    }
  }
  // id fields on bindings and scopes are kept for debugging
  let bindingIdSeq = 0;
  let scopeIdSeq = 0;
  const newScope = (kind, parent) => {
    const s = {
      id: scopeIdSeq++,
      kind,
      parent,
      bindings: new Map(),
      children: [],
      directRefs: []
    };
    if (parent) {
      parent.children.push(s);
    }
    return s;
  };
  const globalScope = newScope("global", null);
  let currentScope = globalScope;
  let pos = 0;
  let strict = false;
  let inAsync = false;
  let inGenerator = false;
  // Suppresses 'in' as a relational operator while parsing a for-statement head, so for-in detection wins
  let noIn = false;
  let refuseReason = null;
  const withFunctionContext = ({ isAsync, isGenerator }, body) => {
    const savedAsync = inAsync;
    const savedGen = inGenerator;
    const savedStrict = strict;
    inAsync = isAsync;
    inGenerator = isGenerator;
    body();
    inAsync = savedAsync;
    inGenerator = savedGen;
    strict = savedStrict;
  };
  const peek = (n = 0) => sig[pos + n];
  const atEnd = () => sig.length <= pos;
  const consume = () => sig[pos++];
  const matchPunct = (v) => (sig[pos]?.type === "punct") && (sig[pos].value === v);
  const matchIdent = (v) => (sig[pos]?.type === "ident") && ((v === undefined) || (sig[pos].value === v));
  const matchType = (typ) => sig[pos]?.type === typ;
  const eatPunct = (v) => {
    if (matchPunct(v)) { consume(); return true; }
    return false;
  };
  const eatIdent = (v) => {
    if (matchIdent(v)) { consume(); return true; }
    return false;
  };
  const describeTok = (t) => t ? `${t.type}('${t.value}')` : "EOF";
  const refuse = (reason) => {
    const e = new Error(reason);
    e.isRefusal = true;
    throw e;
  };
  const expectPunct = (v) => {
    if (!matchPunct(v)) {
      refuse(`expected '${v}', got ${describeTok(peek())} at sig[${pos}]`);
    }
    return consume();
  };
  const expectIdent = (v) => {
    if (!matchIdent(v)) {
      refuse(`expected '${v}', got ${describeTok(peek())} at sig[${pos}]`);
    }
    return consume();
  };
  const hasNewlineBefore = (idx) => (0 < idx) && hasNewlineBeforeSig[idx];
  // ASI fallback for statement terminators
  const consumeSemi = () => {
    if (eatPunct(";") || atEnd() || matchPunct("}") || hasNewlineBefore(pos)) {
      return;
    }
    refuse(`expected ';' or newline before ${describeTok(peek())} at sig[${pos}]`);
  };
  const enterScope = (kind) => {
    currentScope = newScope(kind, currentScope);
  };
  const exitScope = () => {
    currentScope = currentScope.parent;
  };
  const declareInScope = (scope, name) => {
    const binding = scope.bindings.get(name) ?? { id: bindingIdSeq++, name, mangled: null };
    scope.bindings.set(name, binding);
    return binding;
  };
  const hoistTarget = (from) => {
    while (from.parent && !FUNCTION_SCOPE_KINDS.has(from.kind)) {
      from = from.parent;
    }
    return from;
  };
  const declAt = (idx, scope, binding) => {
    sig[idx].role = "decl";
    sig[idx].scope = scope;
    sig[idx].binding = binding;
  };
  const refAt = (idx, scope) => {
    sig[idx].role = "ref";
    sig[idx].scope = scope;
    scope.directRefs.push(idx);
  };
  const propAt = (idx) => {
    sig[idx].role = "property";
  };
  const shorthandPropAt = (idx, scope) => {
    sig[idx].role = "shorthand-prop";
    sig[idx].scope = scope;
    scope.directRefs.push(idx);
  };
  const shorthandPatternAt = (idx, scope, binding) => {
    sig[idx].role = "shorthand-pattern";
    sig[idx].scope = scope;
    sig[idx].binding = binding;
  };
  const isPlainIdentTok = (t) => (
    t?.type === "ident"
    && !RESERVED_ALWAYS.has(t.value)
    && !(strict && RESERVED_STRICT.has(t.value))
  );
  const targetScopeForKind = (kind) => (kind === "var") ? hoistTarget(currentScope) : currentScope;
  const declareIdent = (t, scope, context) => {
    if (!isPlainIdentTok(t)) {
      refuse(`'${t.value}' cannot be ${context}`);
    }
    declAt(pos, scope, declareInScope(scope, t.value));
    consume();
  };
  const parseProgram = () => {
    parseDirectivePrologue();
    while (!atEnd()) {
      parseStatement();
    }
  };
  const parseDirectivePrologue = () => {
    while (peek()?.type === "string") {
      const next = peek(1);
      if (
        (next !== undefined)
        && !((next.type === "punct") && (next.value === ";"))
        && !hasNewlineBefore(pos + 1)
      ) {
        break;
      } else if (peek().value.slice(1, -1) === "use strict") {
        strict = true;
      }
      consume();
      if ((next?.type === "punct") && (next.value === ";")) {
        consume();
      }
    }
  };
  const parseStatement = () => {
    const t = peek();
    if (!t) {
      refuse("unexpected EOF");
    } else if (t.type === "punct") {
      if (t.value === "{") {
        return parseBlockStatement();
      } else if (t.value === ";") {
        consume();
        return;
      } else if (t.value === "@") {
        refuse("decorators not supported");
      } else if (t.value === "<") {
        refuse("JSX not supported");
      }
      return parseExpressionStatement();
    } else if (t.type === "ident") {
      switch (t.value) {
        case "var": return parseVariableDeclaration("var");
        case "const": return parseVariableDeclaration("const");
        case "let": {
          const next = peek(1);
          return (
            ((next?.type === "punct") && PATTERN_OPEN.has(next.value))
            || ((next?.type === "ident") && !RESERVED_ALWAYS.has(next.value))
          ) ? parseVariableDeclaration("let") : parseExpressionStatement();
        }
        case "function": return parseFunctionDeclaration(false);
        case "class": return parseClassDeclaration();
        case "if": return parseIfStatement();
        case "while": return parseWhileStatement();
        case "do": return parseDoWhileStatement();
        case "for": return parseForStatement();
        case "switch": return parseSwitchStatement();
        case "try": return parseTryStatement();
        case "return": return parseReturnStatement();
        case "throw": return parseThrowStatement();
        case "break":
        case "continue":
          return parseBreakOrContinue();
        case "with": refuse("with statement not supported");
        case "debugger": {
          consume();
          consumeSemi();
          return;
        }
        case "import":
        case "export":
          refuse(`ES module syntax ('${t.value}') not supported`);
        case "async": {
          const next = peek(1);
          return ((next?.type === "ident") && (next.value === "function") && !hasNewlineBefore(pos + 1))
            ? parseFunctionDeclaration(true)
            : parseExpressionStatement();
        }
      }
      const next = peek(1);
      return ((next?.type === "punct") && (next.value === ":"))
        ? parseLabeledStatement()
        : parseExpressionStatement();
    }
    return parseExpressionStatement();
  };
  const parseBlockStatement = () => {
    expectPunct("{");
    enterScope("block");
    while (!matchPunct("}")) {
      if (atEnd()) {
        refuse("unclosed block");
      }
      parseStatement();
    }
    consume();
    exitScope();
  };
  const parseExpressionStatement = () => {
    parseExpression();
    consumeSemi();
  };
  const parseBindingElement = (kind) => {
    parseBindingTarget(kind);
    if (eatPunct("=")) {
      parseAssignmentExpression();
    }
  };
  const parseVariableDeclaration = (kind) => {
    consume();
    parseBindingElement(kind);
    while (eatPunct(",")) {
      parseBindingElement(kind);
    }
    consumeSemi();
  };
  const parseBindingTarget = (kind) => {
    const t = peek();
    if (!t) {
      refuse("expected binding target");
    } else if (t.type === "ident") {
      declareIdent(t, targetScopeForKind(kind), "used as a binding name");
      return;
    } else if ((t.type === "punct") && PATTERN_OPEN.has(t.value)) {
      return (t.value === "[") ? parseArrayBindingPattern(kind) : parseObjectBindingPattern(kind);
    }
    refuse(`expected binding name, got ${describeTok(t)}`);
  };
  const parseArrayBindingPattern = (kind) => {
    expectPunct("[");
    while (!matchPunct("]")) {
      if (atEnd()) {
        refuse("unclosed array binding pattern");
      } else if (eatPunct(",")) {
        // Elision
      } else if (eatPunct("...")) {
        parseBindingTarget(kind);
        eatPunct(",");
      } else {
        parseBindingElement(kind);
        if (!matchPunct("]") && !eatPunct(",")) {
          refuse(`expected ',' or ']' in array pattern, got ${describeTok(peek())}`);
        }
      }
    }
    consume();
  };
  const parseObjectBindingPattern = (kind) => {
    expectPunct("{");
    while (!matchPunct("}")) {
      if (atEnd()) {
        refuse("unclosed object binding pattern");
      } else if (eatPunct("...")) {
        parseBindingTarget(kind);
        eatPunct(",");
      } else {
        parseObjectBindingProperty(kind);
        if (!matchPunct("}") && !eatPunct(",")) {
          refuse(`expected ',' or '}' in object pattern, got ${describeTok(peek())}`);
        }
      }
    }
    consume();
  };
  const parseObjectBindingProperty = (kind) => {
    if (matchPunct("[")) {
      consume();
      parseAssignmentExpression();
      expectPunct("]");
      expectPunct(":");
      parseBindingElement(kind);
      return;
    } else if (matchType("string") || matchType("number")) {
      consume();
      expectPunct(":");
      parseBindingElement(kind);
      return;
    } else if (!matchType("ident")) {
      refuse(`expected property name in object pattern, got ${describeTok(peek())}`);
    }
    const keyIdx = pos;
    const keyName = peek().value;
    consume();
    if (eatPunct(":")) {
      propAt(keyIdx);
      parseBindingElement(kind);
      return;
    } else if (RESERVED_ALWAYS.has(keyName)) {
      refuse(`reserved word '${keyName}' cannot be a binding`);
    } else if (strict && RESERVED_STRICT.has(keyName)) {
      refuse(`'${keyName}' is reserved in strict mode`);
    }
    const scope = targetScopeForKind(kind);
    shorthandPatternAt(keyIdx, scope, declareInScope(scope, keyName));
    if (eatPunct("=")) {
      parseAssignmentExpression();
    }
  };
  const parseIfStatement = () => {
    expectIdent("if");
    expectPunct("(");
    parseExpression();
    expectPunct(")");
    parseStatement();
    if (eatIdent("else")) {
      parseStatement();
    }
  };
  const parseWhileStatement = () => {
    expectIdent("while");
    expectPunct("(");
    parseExpression();
    expectPunct(")");
    parseStatement();
  };
  const parseDoWhileStatement = () => {
    expectIdent("do");
    parseStatement();
    expectIdent("while");
    expectPunct("(");
    parseExpression();
    expectPunct(")");
    consumeSemi();
  };
  const parseForInOrOfTail = () => {
    if (eatIdent("in")) {
      parseExpression();
      return true;
    } else if (eatIdent("of")) {
      parseAssignmentExpression();
      return true;
    }
    return false;
  };
  const parseForStatement = () => {
    expectIdent("for");
    if (eatIdent("await") && !inAsync) {
      refuse("for-await outside async context");
    }
    expectPunct("(");
    enterScope("for");
    // noIn forces the parser to skip 'in' as a relational operator inside the head so the for-in detector wins
    const savedNoIn = noIn;
    noIn = true;
    let isForInOrOf = false;
    if (matchIdent("var") || matchIdent("let") || matchIdent("const")) {
      const kind = consume().value;
      parseBindingTarget(kind);
      noIn = savedNoIn;
      isForInOrOf = parseForInOrOfTail();
      if (!isForInOrOf) {
        noIn = true;
        if (eatPunct("=")) {
          parseAssignmentExpression();
        }
        while (eatPunct(",")) {
          parseBindingElement(kind);
        }
      }
    } else if (!matchPunct(";")) {
      parseExpression();
      noIn = savedNoIn;
      isForInOrOf = parseForInOrOfTail();
    }
    noIn = savedNoIn;
    if (!isForInOrOf) {
      expectPunct(";");
      if (!matchPunct(";")) {
        parseExpression();
      }
      expectPunct(";");
      if (!matchPunct(")")) {
        parseExpression();
      }
    }
    expectPunct(")");
    parseStatement();
    exitScope();
  };
  const parseSwitchStatement = () => {
    expectIdent("switch");
    expectPunct("(");
    parseExpression();
    expectPunct(")");
    expectPunct("{");
    enterScope("block");
    while (!matchPunct("}")) {
      if (atEnd()) {
        refuse("unclosed switch");
      } else if (eatIdent("case")) {
        parseExpression();
        expectPunct(":");
      } else if (eatIdent("default")) {
        expectPunct(":");
      } else {
        parseStatement();
      }
    }
    consume();
    exitScope();
  };
  const parseTryStatement = () => {
    expectIdent("try");
    parseBlockStatement();
    if (eatIdent("catch")) {
      enterScope("catch");
      if (eatPunct("(")) {
        parseBindingTarget("catch-param");
        expectPunct(")");
      }
      parseBlockStatement();
      exitScope();
    }
    if (eatIdent("finally")) {
      parseBlockStatement();
    }
  };
  const parseReturnStatement = () => {
    expectIdent("return");
    if (eatPunct(";") || matchPunct("}") || atEnd() || hasNewlineBefore(pos)) {
      return;
    }
    parseExpression();
    consumeSemi();
  };
  const parseThrowStatement = () => {
    expectIdent("throw");
    if (hasNewlineBefore(pos)) {
      refuse("illegal newline after throw");
    }
    parseExpression();
    consumeSemi();
  };
  const parseBreakOrContinue = () => {
    consume();
    if (
      !matchPunct(";") && !matchPunct("}") && !atEnd() && !hasNewlineBefore(pos)
      && matchType("ident")
    ) {
      consume();
    }
    consumeSemi();
  };
  const parseLabeledStatement = () => {
    consume();
    consume();
    parseStatement();
  };
  const parseFunctionDeclaration = (isAsync) => {
    if (isAsync) {
      consume();
    }
    consume();
    const isGenerator = eatPunct("*");
    if (matchType("ident")) {
      declareIdent(peek(), hoistTarget(currentScope), "a function name");
    }
    parseFunctionRest(isAsync, isGenerator);
  };
  const parseFunctionBody = (isAsync, isGenerator, unclosedMsg) => {
    expectPunct("{");
    withFunctionContext({ isAsync, isGenerator }, () => {
      parseDirectivePrologue();
      while (!matchPunct("}")) {
        if (atEnd()) {
          refuse(unclosedMsg);
        }
        parseStatement();
      }
    });
    consume();
  };
  const parseFunctionRest = (isAsync, isGenerator) => {
    enterScope("function");
    expectPunct("(");
    parseSimpleParameters();
    expectPunct(")");
    parseFunctionBody(isAsync, isGenerator, "unclosed function body");
    exitScope();
  };
  // Each param: optional '...', a binding target (ident or pattern), and optional '= default'
  const parseSimpleParameters = () => {
    if (matchPunct(")")) {
      return;
    }
    parseFunctionParam();
    while (eatPunct(",")) {
      if (matchPunct(")")) {
        return;
      }
      parseFunctionParam();
    }
  };
  const parseFunctionParam = () => {
    eatPunct("...");
    parseBindingTarget("param");
    if (eatPunct("=")) {
      parseAssignmentExpression();
    }
  };
  const parseClassDeclaration = () => {
    consume();
    const t = peek();
    if (t?.type !== "ident") {
      refuse("class declaration requires name");
    }
    declareIdent(t, currentScope, "a class name");
    parseClassTail();
  };
  const parseClassTail = () => {
    if (eatIdent("extends")) {
      parseLeftHandSideExpression();
    }
    enterScope("class");
    parseClassBodyContent();
    exitScope();
  };
  const parseClassBodyContent = () => {
    expectPunct("{");
    while (!matchPunct("}")) {
      if (atEnd()) {
        refuse("unclosed class body");
      } else if (!eatPunct(";")) {
        parseClassElement();
      }
    }
    consume();
  };
  // A class modifier is real only if the next token continues a member
  // Inverse when the modifier was the member's own name
  const isModifierFollowedByMember = () => {
    const next = peek(1);
    return (next !== undefined) && (
      (next.type === "punct")
        ? MODIFIER_CONTINUATIONS.has(next.value)
        : PROP_NAME_TYPES.has(next.type)
    );
  };
  const parseClassElement = () => {
    let isAsync = false;
    let isGenerator = false;
    if (matchIdent("static") && isModifierFollowedByMember()) {
      consume();
      if (matchPunct("{")) {
        return parseStaticBlock();
      }
    }
    if (matchIdent("async") && !hasNewlineBefore(pos + 1) && isModifierFollowedByMember()) {
      consume();
      isAsync = true;
    }
    if (matchPunct("*")) {
      consume();
      isGenerator = true;
    }
    if ((matchIdent("get") || matchIdent("set")) && isModifierFollowedByMember()) {
      consume();
    }
    if (matchPunct("[")) {
      consume();
      parseAssignmentExpression();
      expectPunct("]");
    } else if (matchType("private") || matchType("ident")) {
      propAt(pos);
      consume();
    } else if (matchType("string") || matchType("number")) {
      consume();
    } else {
      refuse(`expected class member name, got ${describeTok(peek())}`);
    }
    if (matchPunct("(")) {
      parseMethodBody(isAsync, isGenerator);
      return;
    } else if (eatPunct("=")) {
      enterScope("function");
      withFunctionContext({ isAsync: false, isGenerator: false }, () => {
        parseAssignmentExpression();
      });
      exitScope();
    }
    if (eatPunct(";") || matchPunct("}") || hasNewlineBefore(pos)) {
      return;
    }
    refuse(`expected ';' after class field, got ${describeTok(peek())}`);
  };
  const parseStaticBlock = () => {
    enterScope("function");
    parseFunctionBody(false, false, "unclosed static block");
    exitScope();
  };
  const parseMethodBody = (isAsync, isGenerator) => {
    enterScope("function");
    expectPunct("(");
    parseSimpleParameters();
    expectPunct(")");
    parseFunctionBody(isAsync, isGenerator, "unclosed method body");
    exitScope();
  };
  const parseExpression = () => {
    parseAssignmentExpression();
    while (eatPunct(",")) {
      parseAssignmentExpression();
    }
  };
  // Does the '(' at parenIdx begin an arrow head? O(1) via the precomputed parenMatch table
  // A newline before '=>' is a syntax error in JS, so an arrow head with one is not an arrow
  const lookaheadParenIsArrow = (parenIdx) => {
    const closeIdx = parenMatch[parenIdx];
    if (closeIdx === -1) {
      return false;
    }
    const after = sig[closeIdx + 1];
    return (after?.type === "punct") && (after.value === "=>") && !hasNewlineBefore(closeIdx + 1);
  };
  // Arrow body runs in the arrow scope already entered by the caller, arrows can't be generators
  const parseArrowBody = (isAsync) => {
    withFunctionContext({ isAsync, isGenerator: false }, () => {
      if (matchPunct("{")) {
        consume();
        parseDirectivePrologue();
        while (!matchPunct("}")) {
          if (atEnd()) {
            refuse("unclosed arrow body");
          }
          parseStatement();
        }
        consume();
      } else {
        parseAssignmentExpression();
      }
    });
  };
  // Caller has confirmed '(' starts an arrow head
  const parseParenArrow = (isAsync) => {
    expectPunct("(");
    enterScope("arrow");
    if (!matchPunct(")")) {
      parseFunctionParam();
      while (eatPunct(",") && !matchPunct(")")) {
        parseFunctionParam();
      }
    }
    expectPunct(")");
    expectPunct("=>");
    parseArrowBody(isAsync);
    exitScope();
  };
  // Caller has confirmed ident-then-'=>'
  const parseSingleIdentArrow = (isAsync) => {
    enterScope("arrow");
    declareIdent(peek(), currentScope, "a parameter");
    expectPunct("=>");
    parseArrowBody(isAsync);
    exitScope();
  };
  // Top of the expression precedence ladder
  // Detects arrows (paren and single-ident, sync and async) via lookahead
  const parseAssignmentExpression = () => {
    if (inGenerator && matchIdent("yield")) {
      consume();
      const isDelegate = eatPunct("*");
      const next = peek();
      if (
        (next !== undefined)
        && !((next.type === "punct") && YIELD_TERMINATORS.has(next.value))
        && (isDelegate || !hasNewlineBefore(pos))
      ) {
        parseAssignmentExpression();
      }
      return;
    }
    // 'x => ...': single-ident arrow
    const after = peek(1);
    if (
      isPlainIdentTok(peek())
      && (after?.type === "punct") && (after.value === "=>")
      && !hasNewlineBefore(pos + 1)
    ) {
      return parseSingleIdentArrow(false);
    } else if (matchIdent("async") && !hasNewlineBefore(pos + 1)) {
      // 'async ...': distinguish async arrow head from a plain function call to a binding named 'async'
      const next = peek(1);
      const nextNext = peek(2);
      if (
        (next?.type === "ident") && !RESERVED_ALWAYS.has(next.value)
        && (nextNext?.type === "punct") && (nextNext.value === "=>")
        && !hasNewlineBefore(pos + 2)
      ) {
        consume();
        return parseSingleIdentArrow(true);
      } else if ((next?.type === "punct") && (next.value === "(") && lookaheadParenIsArrow(pos + 1)) {
        consume();
        return parseParenArrow(true);
      }
    } else if (matchPunct("(") && lookaheadParenIsArrow(pos)) {
      // '(...) => ...': paren arrow
      return parseParenArrow(false);
    }
    parseConditionalExpression();
    const t = peek();
    if ((t?.type === "punct") && ASSIGNMENT_OPS.has(t.value)) {
      consume();
      parseAssignmentExpression();
    }
  };
  const parseConditionalExpression = () => {
    parseBinary(0);
    if (eatPunct("?")) {
      parseAssignmentExpression();
      expectPunct(":");
      parseAssignmentExpression();
    }
  };
  // Binary-operator precedence ladder, low precedence first
  // 'in' is gated by noIn so for-in detection wins inside for-statement heads
  const BINARY_LEVELS = [
    () => (
      eatPunct("||")
      || eatPunct("??")
    ), () => (
      eatPunct("&&")
    ), () => (
      eatPunct("|")
    ), () => (
      eatPunct("^")
    ), () => (
      eatPunct("&")
    ), () => (
      eatPunct("===")
      || eatPunct("!==")
      || eatPunct("==")
      || eatPunct("!=")
    ), () => (
      eatPunct("<=")
      || eatPunct(">=")
      || eatPunct("<")
      || eatPunct(">")
      || eatIdent("instanceof")
      || (!noIn && eatIdent("in"))
    ), () => (
      eatPunct("<<")
      || eatPunct(">>")
      || eatPunct(">>>")
    ), () => (
      eatPunct("+")
      || eatPunct("-")
    ), () => (
      eatPunct("*")
      || eatPunct("/")
      || eatPunct("%")
    )
  ];
  const parseBinary = (level) => {
    if (BINARY_LEVELS.length <= level) {
      return parseExponentiation();
    }
    parseBinary(level + 1);
    while (BINARY_LEVELS[level]()) {
      parseBinary(level + 1);
    }
  };
  const parseExponentiation = () => {
    parseUnary();
    if (eatPunct("**")) {
      parseExponentiation();
    }
  };
  const parseUnary = () => {
    if (
      eatIdent("delete")
      || eatIdent("void")
      || eatIdent("typeof")
      || eatPunct("+")
      || eatPunct("-")
      || eatPunct("~")
      || eatPunct("!")
      || (inAsync && eatIdent("await"))
    ) {
      parseUnary();
      return;
    }
    parseUpdate();
  };
  const parseUpdate = () => {
    if (eatPunct("++") || eatPunct("--")) {
      parseUnary();
      return;
    }
    parseLeftHandSideExpression();
    if (!hasNewlineBefore(pos)) {
      eatPunct("++") || eatPunct("--");
    }
  };
  const parseLeftHandSideExpression = () => {
    if (matchIdent("new")) {
      parseNewExpression();
    } else {
      parsePrimaryExpression();
    }
    parseMemberSuffix(true);
  };
  const refuseIfReflectionName = (name, accessForm) => {
    if (REFLECTION_PROP_NAMES.has(name)) {
      refuse(`reflection: ${accessForm} access would observe a renamed binding`);
    }
  };
  // Refuse on 'x["name" | "constructor" | "prototype"]' at the current position; caller already consumed the '['
  const refuseIfReflectionComputed = (optionalChain) => {
    const after = peek(1);
    if (matchType("string") && (after?.type === "punct") && (after.value === "]")) {
      const body = peek().value.slice(1, -1);
      refuseIfReflectionName(body, optionalChain ? `?.['${body}']` : `['${body}']`);
    }
  };
  // After a callee or 'new' operand, walk the member/call chain
  // allowCalls=false stops after the first '(' (the 'new' constructor call)
  // Subsequent calls belong to the outer chain
  const parseMemberSuffix = (allowCalls) => {
    while (true) {
      const t = peek();
      if (!t) {
        return;
      } else if (t.type === "template") {
        consume();
        continue;
      } else if (t.type !== "punct") {
        return;
      } else if (t.value === ".") {
        consume();
        const prop = peek();
        if ((prop?.type !== "ident") && (prop?.type !== "private")) {
          refuse(`expected property name after '.', got ${describeTok(prop)}`);
        } else if (prop.type === "ident") {
          refuseIfReflectionName(prop.value, `'.${prop.value}'`);
        }
        propAt(pos);
        consume();
        continue;
      } else if (t.value === "[") {
        consume();
        refuseIfReflectionComputed(false);
        parseExpression();
        expectPunct("]");
        continue;
      } else if (t.value === "(") {
        parseArguments();
        if (!allowCalls) {
          return;
        }
        continue;
      } else if (t.value === "?.") {
        consume();
        const after = peek();
        if (!after) {
          refuse("expected something after '?.'");
        } else if ((after.type === "punct") && (after.value === "(")) {
          parseArguments();
          continue;
        } else if ((after.type === "punct") && (after.value === "[")) {
          consume();
          refuseIfReflectionComputed(true);
          parseExpression();
          expectPunct("]");
          continue;
        } else if ((after.type === "ident") || (after.type === "private")) {
          if (after.type === "ident") {
            refuseIfReflectionName(after.value, `'?.${after.value}'`);
          }
          propAt(pos);
          consume();
          continue;
        } else if (after.type === "template") {
          refuse("tagged optional template not allowed");
        }
        refuse(`unexpected token after '?.': ${describeTok(after)}`);
      }
      return;
    }
  };
  const parseNewExpression = () => {
    consume();
    // 'new.target' meta property, treat as opaque expression result, no rename
    if (eatPunct(".")) {
      if (!eatIdent("target")) {
        refuse("expected 'target' after 'new.'");
      }
      return;
    }
    if (matchIdent("new")) {
      parseNewExpression();
    } else {
      parsePrimaryExpression();
    }
    parseMemberSuffix(false);
  };
  const parseArguments = () => {
    expectPunct("(");
    if (eatPunct(")")) {
      return;
    }
    parseArgumentItem();
    while (eatPunct(",")) {
      if (matchPunct(")")) {
        break;
      }
      parseArgumentItem();
    }
    expectPunct(")");
  };
  const parseArgumentItem = () => {
    eatPunct("...");
    parseAssignmentExpression();
  };
  const parsePrimaryExpression = () => {
    const t = peek();
    if (!t) {
      refuse("expected expression");
    }
    if (t.type === "punct") {
      switch (t.value) {
        case "(": return parseParenthesizedExpression();
        case "[": return parseArrayLiteral();
        case "{": return parseObjectLiteral();
      }
      refuse(`unexpected '${t.value}' at start of expression`);
    } else if (t.type === "ident") {
      switch (t.value) {
        case "this":
        case "true":
        case "false":
        case "null": {
          consume();
          return;
        }
        case "function": return parseFunctionExpression(false);
        case "class": return parseClassExpression();
        case "new": return parseNewExpression();
        case "async": {
          const next = peek(1);
          if ((next?.type === "ident") && (next.value === "function") && !hasNewlineBefore(pos + 1)) {
            return parseFunctionExpression(true);
          }
          // async arrows are caught upstream by parseAssignmentExpression, bare 'async' here is just an identifier reference
          refAt(pos, currentScope);
          consume();
          return;
        }
        case "super": {
          consume();
          const next = peek();
          if ((next?.type === "punct") && SUPER_FOLLOWERS.has(next.value)) {
            return;
          }
          refuse("super must be followed by call or member access");
        }
      }
      if (RESERVED_ALWAYS.has(t.value)) {
        refuse(`unexpected reserved word '${t.value}' in expression`);
      } else if (strict && RESERVED_STRICT.has(t.value)) {
        refuse(`'${t.value}' is reserved in strict mode`);
      } else if (REFUSE_GLOBAL_REFS.has(t.value)) {
        refuse(`reflection: reference to '${t.value}' could observe renamed bindings`);
      }
      refAt(pos, currentScope);
      consume();
      return;
    } else if (t.type === "private") {
      refuse("private identifier outside class body");
    } else if (LITERAL_TOKEN_TYPES.has(t.type)) {
      consume();
      return;
    }
    refuse(`unexpected ${describeTok(t)} in expression`);
  };
  // Arrow forms are detected upstream by parseAssignmentExpression via lookaheadParenIsArrow
  const parseParenthesizedExpression = () => {
    expectPunct("(");
    if (matchPunct(")")) {
      refuse("unexpected empty parens; an arrow head should have been detected upstream");
    }
    parseExpression();
    expectPunct(")");
    if (matchPunct("=>")) {
      refuse("unexpected arrow head reached parenthesized expression; lookahead missed it");
    }
  };
  const parseArrayLiteral = () => {
    expectPunct("[");
    while (!matchPunct("]")) {
      if (atEnd()) {
        refuse("unclosed array literal");
      } else if (!eatPunct(",")) {
        eatPunct("...");
        parseAssignmentExpression();
        if (!matchPunct("]") && !eatPunct(",")) {
          refuse(`expected ',' or ']' in array literal, got ${describeTok(peek())}`);
        }
      }
    }
    consume();
  };
  const parseObjectLiteral = () => {
    expectPunct("{");
    while (!matchPunct("}")) {
      if (atEnd()) {
        refuse("unclosed object literal");
      }
      parseObjectProperty();
      if (!matchPunct("}") && !eatPunct(",")) {
        refuse(`expected ',' or '}' in object literal, got ${describeTok(peek())}`);
      }
    }
    consume();
  };
  const nextIsPropertyNameStart = (delta, allowStar) => {
    const next = peek(delta);
    return (next !== undefined) && (
      PROP_NAME_TYPES.has(next.type)
      || ((next.type === "punct") && ((next.value === "[") || (allowStar && (next.value === "*"))))
    );
  };
  const parseObjectProperty = () => {
    if (eatPunct("...")) {
      parseAssignmentExpression();
      return;
    }
    let isAsync = false;
    let isGenerator = false;
    let isAccessor = false;
    if (matchIdent("async") && !hasNewlineBefore(pos + 1) && nextIsPropertyNameStart(1, true)) {
      consume();
      isAsync = true;
    }
    if (matchPunct("*")) {
      consume();
      isGenerator = true;
    }
    if (!isAsync && !isGenerator && (matchIdent("get") || matchIdent("set")) && nextIsPropertyNameStart(1, false)) {
      isAccessor = true;
      consume();
    }
    let keyKind = null;
    let keySigIdx = -1;
    if (matchPunct("[")) {
      consume();
      parseAssignmentExpression();
      expectPunct("]");
      keyKind = "computed";
    } else if (matchType("ident")) {
      keyKind = "ident";
      keySigIdx = pos;
      consume();
    } else if (matchType("string") || matchType("number")) {
      keyKind = "literal";
      consume();
    } else {
      refuse(`expected property name, got ${describeTok(peek())}`);
    }
    if (isAsync || isGenerator || isAccessor) {
      if (keyKind === "ident") {
        propAt(keySigIdx);
      }
      parseMethodBody(isAsync, isGenerator);
      return;
    } else if (eatPunct(":")) {
      if (keyKind === "ident") {
        propAt(keySigIdx);
      }
      parseAssignmentExpression();
      return;
    } else if (matchPunct("(")) {
      if (keyKind === "ident") {
        propAt(keySigIdx);
      }
      parseMethodBody(false, false);
      return;
    } else if (keyKind === "ident") {
      // Shorthand: { foo } means { foo: foo }
      const t = sig[keySigIdx];
      if (RESERVED_ALWAYS.has(t.value)) {
        refuse(`unexpected reserved word '${t.value}' as shorthand`);
      } else if (strict && RESERVED_STRICT.has(t.value)) {
        refuse(`'${t.value}' is reserved in strict mode`);
      }
      shorthandPropAt(keySigIdx, currentScope);
      if (matchPunct("=")) {
        refuse("cover-initialized property requires destructure context");
      }
      return;
    }
    refuse(`computed/literal property requires ':' followed by value`);
  };
  const parseFunctionExpression = (isAsync) => {
    if (isAsync) {
      consume();
    }
    consume();
    const isGenerator = eatPunct("*");
    if (!matchType("ident") || RESERVED_ALWAYS.has(peek().value)) {
      parseFunctionRest(isAsync, isGenerator);
      return;
    }
    // Named function expression: name is visible only inside the function body
    enterScope("function");
    declareIdent(peek(), currentScope, "a function name");
    expectPunct("(");
    parseSimpleParameters();
    expectPunct(")");
    parseFunctionBody(isAsync, isGenerator, "unclosed function body");
    exitScope();
  };
  const parseClassExpression = () => {
    expectIdent("class");
    const head = peek();
    if (!matchType("ident") || RESERVED_ALWAYS.has(head.value) || (head.value === "extends")) {
      parseClassTail();
      return;
    }
    // Named class expression: name is visible only inside the class body
    enterScope("class");
    declareIdent(head, currentScope, "a class name");
    if (eatIdent("extends")) {
      parseLeftHandSideExpression();
    }
    parseClassBodyContent();
    exitScope();
  };
  try {
    parseProgram();
    if (!atEnd()) {
      refuse(`unexpected token at end: ${describeTok(peek())}`);
    }
  } catch (e) {
    if (!e?.isRefusal) {
      throw e;
    }
    refuseReason = e.message;
  }
  if (refuseReason !== null) {
    onWarning(`mangler refused: ${refuseReason}; falling back to minify-only`);
    return minify(source);
  }
  for (const t of sig) {
    if (!REF_ROLES.has(t.role)) {
      continue;
    }
    for (let scope = t.scope; scope; scope = scope.parent) {
      const binding = scope.bindings.get(t.value);
      if (binding) {
        t.binding = binding;
        break;
      }
    }
  }
  const preservedAlways = new Set();
  for (const t of tokens) {
    if (t.type !== "template") {
      continue;
    }
    for (const interp of t.interpolationTexts) {
      for (const m of interp.matchAll(/[$_a-zA-Z][$_a-zA-Z0-9]*/g)) {
        preservedAlways.add(m[0]);
      }
    }
  }
  const assignNamesForScope = (scope, namesFromOutside = []) => {
    const forbidden = new Set([...namesFromOutside, ...preservedAlways]);
    const stack = [scope];
    while (0 < stack.length) {
      const s = stack.pop();
      for (const idx of s.directRefs) {
        const t = sig[idx];
        if (REF_ROLES.has(t.role) && !t.binding) {
          forbidden.add(t.value);
        }
      }
      for (const child of s.children) {
        stack.push(child);
      }
    }
    let nameIdx = 0;
    for (const binding of scope.bindings.values()) {
      if (preservedAlways.has(binding.name)) {
        binding.mangled = binding.name;
        forbidden.add(binding.name);
        continue;
      }
      let candidate;
      do {
        candidate = generateMangledName(nameIdx);
        nameIdx++;
      } while (
        forbidden.has(candidate)
        || MANGLER_NAME_BLACKLIST.has(candidate)
        || !isValidIdentifier(candidate)
      );
      binding.mangled = candidate;
      forbidden.add(candidate);
    }
    for (const child of scope.children) {
      assignNamesForScope(child, forbidden);
    }
  };
  assignNamesForScope(globalScope);
  for (const [i, t] of sig.entries()) {
    if (!t.binding) {
      continue;
    }
    const tokIdx = sigToTok[i];
    if ((t.role === "decl") || (t.role === "ref")) {
      tokens[tokIdx].value = t.binding.mangled;
    } else if (
      ((t.role === "shorthand-prop") || (t.role === "shorthand-pattern"))
      && (t.binding.mangled !== t.binding.name)
    ) {
      tokens[tokIdx].value = `${t.binding.name}: ${t.binding.mangled}`;
    }
  }
  return renderTokens();
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const usage = "Usage: node voyage-triggers-compiler.mjs <path> [--compact] [--no-mangle] [--no-minify]";
  let path = null;
  let compact = false;
  let mangleFlag = true;
  let minifyFlag = true;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--compact") {
      compact = true;
    } else if (arg === "--no-mangle") {
      mangleFlag = false;
    } else if (arg === "--no-minify") {
      minifyFlag = false;
    } else if ((arg === "--help") || (arg === "-h")) {
      console.log(usage);
      process.exit(0);
    } else if (path === null) {
      path = arg;
    } else {
      console.error("Unknown argument:", arg);
      console.error(usage);
      process.exit(2);
    }
  }
  if (path === null) {
    console.error(usage);
    process.exit(2);
  }
  const absPath = resolve(path);
  let absStat;
  try {
    absStat = statSync(absPath);
  } catch {
    console.error("Path does not exist:", absPath);
    process.exit(1);
  }
  const isFile = absStat.isFile();
  const isDir = absStat.isDirectory();
  if (!isFile && !isDir) {
    console.error("Not a file or directory:", absPath);
    process.exit(1);
  }
  const files = isFile
    ? [absPath]
    : readdirSync(absPath, { withFileTypes: true })
        .filter((e) => e.isFile() && (e.name.endsWith(".js") || e.name.endsWith(".mjs")))
        .map((e) => join(absPath, e.name))
        .sort();
  if (files.length === 0) {
    console.error("No .js or .mjs files at:", absPath);
    process.exit(1);
  }
  const outPath = join(isDir ? absPath : dirname(absPath), "triggers.json");
  const triggers = Object.create(null);
  const fileByName = new Map();
  for (const file of files) {
    let trigger;
    try {
      const source = readFileSync(file, "utf8");
      const tokens = tokenize(source);
      const sig = [];
      let sig4Idx;
      for (const [i, t] of tokens.entries()) {
        if (TRIVIA_TOKEN_TYPES.has(t.type)) {
          continue;
        }
        sig.push(t);
        if (sig.length === 5) {
          sig4Idx = i;
          break;
        }
      }
      let meta;
      let body;
      if (!(
        (5 <= sig.length)
        && (sig[0].type === "ident") && (sig[0].value === "export")
        && (sig[1].type === "ident") && (sig[1].value === "const")
        && (sig[2].type === "ident") && (sig[2].value === "meta")
        && (sig[3].type === "punct") && (sig[3].value === "=")
        && (sig[4].type === "punct") && (sig[4].value === "{")
      )) {
        meta = {};
        body = source;
      } else {
        let depth = 1;
        let endPos = -1;
        for (let i = sig4Idx + 1; i < tokens.length; i++) {
          const t = tokens[i];
          if (t.type !== "punct") {
            continue;
          } else if (t.value === "{") {
            depth++;
          } else if (t.value === "}") {
            if (--depth === 0) {
              endPos = t.start + t.value.length;
              break;
            }
          }
        }
        if (endPos === -1) {
          throw new Error("Unclosed meta object literal");
        }
        // Meta is evaluated as JS so only run this on code you own
        try {
          meta = new Function(`return (${source.slice(sig[4].start, endPos)});`)();
        } catch (err) {
          throw new Error(`meta literal failed to evaluate: ${err.message}`);
        }
        if ((meta === null) || (typeof meta !== "object") || Array.isArray(meta)) {
          throw new Error("meta must be a plain object literal");
        }
        let bodyStart = endPos;
        while ((bodyStart < source.length) && (isWhitespace(source[bodyStart]) || (source[bodyStart] === ";"))) {
          bodyStart++;
        }
        body = source.slice(bodyStart);
      }
      if (Object.hasOwn(meta, "script")) {
        console.warn(`${basename(file)}: meta.script is ignored, the file body becomes the script`);
      }
      const { name, conditions = [], script: _, effects = [], recurring = true, ...rest } = meta;
      let script = body.trim();
      if (mangleFlag && (0 < script.length)) {
        script = mangle(script, {
          onWarning: (msg) => console.warn(`${basename(file)}: ${msg}`)
        });
      }
      if (minifyFlag && (0 < script.length)) {
        script = minify(script).trim();
      }
      trigger = {
        name: name ?? basename(file, extname(file)),
        conditions,
        ...((0 < script.length) && { script }),
        effects,
        ...(recurring && { recurring }),
        ...rest
      };
    } catch (err) {
      console.error(`Error building ${file}:`, err.message);
      process.exit(1);
    }
    if (Object.hasOwn(triggers, trigger.name)) {
      console.error(`Name collision: '${trigger.name}' is defined by both ${fileByName.get(trigger.name)} and ${file}`);
      process.exit(1);
    }
    triggers[trigger.name] = trigger;
    fileByName.set(trigger.name, file);
  }
  const sorted = Object.fromEntries(Object.entries(triggers).sort(([a], [b]) => (a < b) ? -1 : 1));
  const warnIfOver = (value, limit, prefix, unit) => {
    if (limit < value) {
      console.warn(`warn: ${prefix}${value} ${unit} exceeds ${limit} cap`);
    }
  };
  let semantic = 0;
  let mechanical = 0;
  for (const [name, trig] of Object.entries(sorted)) {
    warnIfOver(JSON.stringify(trig).length, LIMITS.perTriggerCompactJson, `${name}: trigger compact JSON `, "chars");
    warnIfOver(trig.conditions.length, LIMITS.conditionsPerTrigger, `${name}: `, "conditions");
    warnIfOver(trig.effects.length, LIMITS.effectsPerTrigger, `${name}: `, "effects");
    if (trig.conditions.some((c) => SEMANTIC_CONDITION_TYPES.has(c?.type))) {
      semantic++;
    } else {
      mechanical++;
    }
  }
  warnIfOver(semantic, LIMITS.semanticTriggers, "", "semantic triggers");
  warnIfOver(mechanical, LIMITS.mechanicalTriggers, "", "mechanical triggers");
  writeFileSync(outPath, JSON.stringify(sorted, null, compact ? 0 : 2) + "\n");
  const count = Object.keys(sorted).length;
  console.log(`Wrote ${count} trigger${count === 1 ? "" : "s"} to ${outPath}`);
}

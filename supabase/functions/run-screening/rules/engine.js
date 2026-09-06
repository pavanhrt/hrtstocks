// Deterministic expression evaluator for strategy rule "expression" strings,
// e.g. "ema_5 > ema_13 and ema_13 > ema_26" or "risk > 0 and reward / risk >= minimum_reward_risk".
//
// Deliberately not `eval`/`Function`: this is a small recursive-descent parser
// over a fixed grammar (booleans, comparisons, arithmetic, identifiers,
// literals) so every expression in strategies/*.yaml is executed the same way
// it reads on the page, with no way to smuggle in side effects.
//
// Plain ESM/JS on purpose (no TypeScript build step) so the exact same file
// runs under Node (local tests, seed tooling) and Deno (the deployed Edge
// Function) via a relative import.

const TOKEN_RE =
  /\s*(=>|<=|>=|==|!=|<|>|\(|\)|\[|\]|,|\+|-|\*|\/|'[^']*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_.]*|-?\d+\.\d+|-?\d+)\s*/y;

const KEYWORDS = new Set(["and", "or", "not", "true", "false", "null"]);

export class ExpressionError extends Error {}

function tokenize(source) {
  const tokens = [];
  let pos = 0;
  TOKEN_RE.lastIndex = 0;
  while (pos < source.length) {
    TOKEN_RE.lastIndex = pos;
    const match = TOKEN_RE.exec(source);
    if (!match || match.index !== pos) {
      throw new ExpressionError(`Unrecognized token at position ${pos} in: ${source}`);
    }
    tokens.push(match[1]);
    pos = TOKEN_RE.lastIndex;
  }
  return tokens;
}

// Grammar (lowest to highest precedence):
//   or_expr    := and_expr ("or" and_expr)*
//   and_expr   := not_expr ("and" not_expr)*
//   not_expr   := "not" not_expr | comparison
//   comparison := additive (("==" | "!=" | "<" | "<=" | ">" | ">=") additive)?
//   additive   := multiplicative (("+" | "-") multiplicative)*
//   multiplicative := unary (("*" | "/") unary)*
//   unary      := "-" unary | primary
//   primary    := NUMBER | STRING | "true" | "false" | "null" | IDENTIFIER | "(" or_expr ")"
class Parser {
  constructor(tokens, context) {
    this.tokens = tokens;
    this.pos = 0;
    this.context = context;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  expect(token) {
    if (this.peek() !== token) {
      throw new ExpressionError(`Expected "${token}" but got "${this.peek()}"`);
    }
    return this.next();
  }

  parse() {
    const value = this.orExpr();
    if (this.pos !== this.tokens.length) {
      throw new ExpressionError(`Unexpected trailing token "${this.peek()}"`);
    }
    return value;
  }

  orExpr() {
    let left = this.andExpr();
    while (this.peek() === "or") {
      this.next();
      const right = this.andExpr();
      // Kleene three-valued OR: a known `true` on either side wins even if
      // the other side is unknown; only two unknowns (or unknown+false)
      // stay unknown.
      left = left === true || right === true ? true : left === null || right === null ? null : left || right;
    }
    return left;
  }

  andExpr() {
    let left = this.notExpr();
    while (this.peek() === "and") {
      this.next();
      const right = this.notExpr();
      // Kleene three-valued AND: a known `false` on either side wins even if
      // the other side is unknown (missing data can't turn a failed gate
      // into an unresolved one); only two unknowns (or unknown+true) stay
      // unknown.
      left = left === false || right === false ? false : left === null || right === null ? null : left && right;
    }
    return left;
  }

  notExpr() {
    if (this.peek() === "not") {
      this.next();
      const value = this.notExpr();
      return value === null ? null : !value;
    }
    return this.comparison();
  }

  comparison() {
    const left = this.additive();
    const op = this.peek();
    if (["==", "!=", "<", "<=", ">", ">="].includes(op)) {
      this.next();
      const right = this.additive();
      if (left === null || right === null) return null;
      switch (op) {
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case "<":
          return left < right;
        case "<=":
          return left <= right;
        case ">":
          return left > right;
        case ">=":
          return left >= right;
      }
    }
    if (op === "in") {
      this.next();
      const right = this.additive();
      if (left === null || right === null) return null;
      if (!Array.isArray(right)) {
        throw new ExpressionError('Right-hand side of "in" must be a list literal');
      }
      return right.includes(left);
    }
    return left;
  }

  additive() {
    let left = this.multiplicative();
    while (this.peek() === "+" || this.peek() === "-") {
      const op = this.next();
      const right = this.multiplicative();
      if (left === null || right === null) {
        left = null;
      } else {
        left = op === "+" ? left + right : left - right;
      }
    }
    return left;
  }

  multiplicative() {
    let left = this.unary();
    while (this.peek() === "*" || this.peek() === "/") {
      const op = this.next();
      const right = this.unary();
      if (left === null || right === null) {
        left = null;
      } else if (op === "/" && right === 0) {
        left = null; // never throw on div-by-zero; surfaces as NO_DATA/MANUAL_REVIEW upstream
      } else {
        left = op === "*" ? left * right : left / right;
      }
    }
    return left;
  }

  unary() {
    if (this.peek() === "-") {
      this.next();
      const value = this.unary();
      return value === null ? null : -value;
    }
    return this.primary();
  }

  primary() {
    const token = this.next();
    if (token === undefined) {
      throw new ExpressionError("Unexpected end of expression");
    }
    if (token === "(") {
      const value = this.orExpr();
      this.expect(")");
      return value;
    }
    if (token === "[") {
      const items = [];
      if (this.peek() !== "]") {
        items.push(this.orExpr());
        while (this.peek() === ",") {
          this.next();
          items.push(this.orExpr());
        }
      }
      this.expect("]");
      return items;
    }
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    if (/^-?\d+\.\d+$/.test(token) || /^-?\d+$/.test(token)) {
      return Number(token);
    }
    if (
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))
    ) {
      return token.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(token) && !KEYWORDS.has(token)) {
      if (!(token in this.context)) {
        throw new ExpressionError(`Unknown identifier "${token}"`);
      }
      const value = this.context[token];
      return value === undefined ? null : value;
    }
    throw new ExpressionError(`Unexpected token "${token}"`);
  }
}

/**
 * Evaluate a strategy-rule expression string against a feature context.
 *
 * @param {string} expression - e.g. "ema_5 > ema_13 and ema_13 > ema_26"
 * @param {Record<string, number|string|boolean|null>} context - resolved feature values
 * @returns {boolean|number|string|null} null means "cannot be determined" (missing input),
 *   which callers must map to the rule's missing_result, never to a pass.
 */
export function evaluateExpression(expression, context) {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens, context);
  return parser.parse();
}

//! Expression evaluator for the programmable report engine.
//!
//! Grammar (whitespace-insensitive):
//!   expr   := term (('+' | '-') term)*
//!   term   := factor (('*' | '/') factor)*
//!   factor := number | ref | func | '(' expr ')' | '-' factor
//!   ref    := 'M:' code      (a single map total)
//!           | 'G:' groupId   (sum of accounts in a grouping)
//!           | 'A:' acctNo     (a single account's balance)
//!           | 'L:' lineno    (another line's already-computed value)
//!           | 'V:' key       (a custom variable, parsed as a number)
//!   func   := 'SUM' '(' code '..' code ')'   (sum map totals whose code sorts in range, inclusive)
//!
//! Evaluation happens per axis (current or prior) so M:/L: resolve to the right column.

use std::collections::HashMap;

/// Per-axis lookup context handed to the evaluator.
pub struct EvalContext<'a> {
    /// map code -> total for this axis
    pub map_totals: &'a HashMap<String, f64>,
    /// every map code present (for SUM range expansion), pre-sorted
    pub map_codes: &'a [String],
    /// grouping id (as string) -> summed account total for this axis
    pub group_totals: &'a HashMap<String, f64>,
    /// account number -> balance for this axis
    pub account_totals: &'a HashMap<String, f64>,
    /// line_no -> already-resolved value for this axis (lines evaluate top-down)
    pub line_values: &'a HashMap<i64, f64>,
    /// custom var key -> raw string value
    pub vars: &'a HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Num(f64),
    Map(String),
    Group(String),
    Account(String),
    Line(i64),
    Var(String),
    SumRange(String, String),
    Plus,
    Minus,
    Star,
    Slash,
    LParen,
    RParen,
}

fn tokenize(input: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    let mut tokens = Vec::new();

    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        match c {
            '+' => { tokens.push(Token::Plus); i += 1; }
            '-' => { tokens.push(Token::Minus); i += 1; }
            '*' => { tokens.push(Token::Star); i += 1; }
            '/' => { tokens.push(Token::Slash); i += 1; }
            '(' => { tokens.push(Token::LParen); i += 1; }
            ')' => { tokens.push(Token::RParen); i += 1; }
            '0'..='9' | '.' => {
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                    i += 1;
                }
                let s: String = chars[start..i].iter().collect();
                let n: f64 = s.parse().map_err(|_| format!("Invalid number '{s}'"))?;
                tokens.push(Token::Num(n));
            }
            _ if c.is_ascii_alphabetic() => {
                // Either a prefixed ref (M:/L:/V:) or the SUM function.
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();

                if i < chars.len() && chars[i] == ':' {
                    i += 1; // consume ':'
                    // read the identifier/code after the colon
                    let id_start = i;
                    while i < chars.len()
                        && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '-')
                    {
                        i += 1;
                    }
                    let id: String = chars[id_start..i].iter().collect();
                    if id.is_empty() {
                        return Err(format!("Expected identifier after '{word}:'"));
                    }
                    match word.to_uppercase().as_str() {
                        "M" => tokens.push(Token::Map(id)),
                        "G" => tokens.push(Token::Group(id)),
                        "A" => tokens.push(Token::Account(id)),
                        "L" => {
                            let n: i64 = id.parse().map_err(|_| format!("L: needs a line number, got '{id}'"))?;
                            tokens.push(Token::Line(n));
                        }
                        "V" => tokens.push(Token::Var(id)),
                        other => return Err(format!("Unknown reference prefix '{other}:'")),
                    }
                } else if word.eq_ignore_ascii_case("SUM") {
                    // SUM ( code .. code )
                    skip_ws(&chars, &mut i);
                    if i >= chars.len() || chars[i] != '(' {
                        return Err("SUM must be followed by '('".into());
                    }
                    i += 1;
                    let a = read_code(&chars, &mut i)?;
                    skip_ws(&chars, &mut i);
                    if i + 1 >= chars.len() || chars[i] != '.' || chars[i + 1] != '.' {
                        return Err("SUM range needs '..' between codes".into());
                    }
                    i += 2;
                    let b = read_code(&chars, &mut i)?;
                    skip_ws(&chars, &mut i);
                    if i >= chars.len() || chars[i] != ')' {
                        return Err("SUM is missing closing ')'".into());
                    }
                    i += 1;
                    tokens.push(Token::SumRange(a, b));
                } else {
                    return Err(format!("Unexpected token '{word}'"));
                }
            }
            _ => return Err(format!("Unexpected character '{c}'")),
        }
    }
    Ok(tokens)
}

fn skip_ws(chars: &[char], i: &mut usize) {
    while *i < chars.len() && chars[*i].is_whitespace() {
        *i += 1;
    }
}

fn read_code(chars: &[char], i: &mut usize) -> Result<String, String> {
    skip_ws(chars, i);
    let start = *i;
    while *i < chars.len() && (chars[*i].is_ascii_alphanumeric() || chars[*i] == '_' || chars[*i] == '-') {
        *i += 1;
    }
    if *i == start {
        return Err("Expected a map code".into());
    }
    Ok(chars[start..*i].iter().collect())
}

// ── Recursive-descent parser/evaluator over the token stream ──────────────────

struct Parser<'a, 'b> {
    tokens: Vec<Token>,
    pos: usize,
    ctx: &'a EvalContext<'b>,
}

impl<'a, 'b> Parser<'a, 'b> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }
    fn next(&mut self) -> Option<Token> {
        let t = self.tokens.get(self.pos).cloned();
        self.pos += 1;
        t
    }

    fn expr(&mut self) -> Result<f64, String> {
        let mut acc = self.term()?;
        while let Some(op) = self.peek() {
            match op {
                Token::Plus => { self.next(); acc += self.term()?; }
                Token::Minus => { self.next(); acc -= self.term()?; }
                _ => break,
            }
        }
        Ok(acc)
    }

    fn term(&mut self) -> Result<f64, String> {
        let mut acc = self.factor()?;
        while let Some(op) = self.peek() {
            match op {
                Token::Star => { self.next(); acc *= self.factor()?; }
                Token::Slash => {
                    self.next();
                    let d = self.factor()?;
                    if d == 0.0 { return Err("Division by zero".into()); }
                    acc /= d;
                }
                _ => break,
            }
        }
        Ok(acc)
    }

    fn factor(&mut self) -> Result<f64, String> {
        match self.next() {
            Some(Token::Num(n)) => Ok(n),
            Some(Token::Minus) => Ok(-self.factor()?),
            Some(Token::LParen) => {
                let v = self.expr()?;
                match self.next() {
                    Some(Token::RParen) => Ok(v),
                    _ => Err("Missing ')'".into()),
                }
            }
            Some(Token::Map(code)) => Ok(*self.ctx.map_totals.get(&code).unwrap_or(&0.0)),
            Some(Token::Group(id)) => Ok(*self.ctx.group_totals.get(&id).unwrap_or(&0.0)),
            Some(Token::Account(acct)) => Ok(*self.ctx.account_totals.get(&acct).unwrap_or(&0.0)),
            Some(Token::Line(n)) => self
                .ctx
                .line_values
                .get(&n)
                .copied()
                .ok_or_else(|| format!("L:{n} not yet computed (must reference a line above)")),
            Some(Token::Var(key)) => {
                let raw = self
                    .ctx
                    .vars
                    .get(&key)
                    .ok_or_else(|| format!("Variable V:{key} not found"))?;
                raw.trim().replace([',', '$'], "").parse::<f64>()
                    .map_err(|_| format!("V:{key} ('{raw}') is not numeric"))
            }
            Some(Token::SumRange(a, b)) => {
                let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
                let mut sum = 0.0;
                for code in self.ctx.map_codes {
                    if *code >= lo && *code <= hi {
                        sum += *self.ctx.map_totals.get(code).unwrap_or(&0.0);
                    }
                }
                Ok(sum)
            }
            other => Err(format!("Unexpected token {other:?}")),
        }
    }
}

/// Evaluate an expression for one axis. Returns the numeric result.
pub fn eval(expr: &str, ctx: &EvalContext) -> Result<f64, String> {
    let tokens = tokenize(expr)?;
    if tokens.is_empty() {
        return Ok(0.0);
    }
    let mut p = Parser { tokens, pos: 0, ctx };
    let v = p.expr()?;
    if p.pos != p.tokens.len() {
        return Err("Trailing tokens after expression".into());
    }
    Ok(v)
}

/// Resolve a VAR line's raw text (no numeric parsing).
pub fn resolve_var_text(key: &str, vars: &HashMap<String, String>) -> Option<String> {
    vars.get(key).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(
        maps: &'a HashMap<String, f64>,
        codes: &'a [String],
        lines: &'a HashMap<i64, f64>,
        vars: &'a HashMap<String, String>,
    ) -> EvalContext<'a> {
        // Groups/accounts share lifetime tricks via leaked empties in tests below.
        EvalContext {
            map_totals: maps,
            map_codes: codes,
            group_totals: &EMPTY_F64,
            account_totals: &EMPTY_F64,
            line_values: lines,
            vars,
        }
    }

    use std::sync::LazyLock;
    static EMPTY_F64: LazyLock<HashMap<String, f64>> = LazyLock::new(HashMap::new);

    #[test]
    fn arithmetic() {
        let (m, c, l, v) = (HashMap::new(), vec![], HashMap::new(), HashMap::new());
        assert_eq!(eval("2 + 3 * 4", &ctx(&m, &c, &l, &v)).unwrap(), 14.0);
        assert_eq!(eval("(2 + 3) * 4", &ctx(&m, &c, &l, &v)).unwrap(), 20.0);
        assert_eq!(eval("-5 + 10", &ctx(&m, &c, &l, &v)).unwrap(), 5.0);
    }

    #[test]
    fn map_and_line_refs() {
        let mut m = HashMap::new();
        m.insert("1000".to_string(), 500.0);
        m.insert("1100".to_string(), 250.0);
        let codes = vec!["1000".to_string(), "1100".to_string()];
        let mut l = HashMap::new();
        l.insert(5, 100.0);
        let v = HashMap::new();
        assert_eq!(eval("M:1000 + M:1100", &ctx(&m, &codes, &l, &v)).unwrap(), 750.0);
        assert_eq!(eval("L:5 * 2", &ctx(&m, &codes, &l, &v)).unwrap(), 200.0);
        // unknown map is 0
        assert_eq!(eval("M:9999", &ctx(&m, &codes, &l, &v)).unwrap(), 0.0);
    }

    #[test]
    fn sum_range() {
        let mut m = HashMap::new();
        m.insert("1000".to_string(), 100.0);
        m.insert("1500".to_string(), 200.0);
        m.insert("1999".to_string(), 50.0);
        m.insert("2000".to_string(), 999.0); // outside
        let codes = vec![
            "1000".to_string(), "1500".to_string(), "1999".to_string(), "2000".to_string(),
        ];
        let l = HashMap::new();
        let v = HashMap::new();
        assert_eq!(eval("SUM(1000..1999)", &ctx(&m, &codes, &l, &v)).unwrap(), 350.0);
    }

    #[test]
    fn var_numeric() {
        let (m, c, l) = (HashMap::new(), vec![], HashMap::new());
        let mut v = HashMap::new();
        v.insert("tax_rate".to_string(), "0.25".to_string());
        assert_eq!(eval("V:tax_rate * 100", &ctx(&m, &c, &l, &v)).unwrap(), 25.0);
    }

    #[test]
    fn errors() {
        let (m, c, l, v) = (HashMap::new(), vec![], HashMap::new(), HashMap::new());
        assert!(eval("1 / 0", &ctx(&m, &c, &l, &v)).is_err());
        assert!(eval("L:99", &ctx(&m, &c, &l, &v)).is_err());
        assert!(eval("2 +", &ctx(&m, &c, &l, &v)).is_err());
    }
}

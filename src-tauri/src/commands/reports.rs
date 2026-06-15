use crate::error::{AppError, Result};
use crate::models::{
    map_engagement_row, CustomVar, EngagementMeta, MapTotal, ReportData, ResolvedLine,
    ResolvedStatement, Statement, StatementLine, ENGAGEMENT_COLUMNS,
};
use crate::report_engine::{eval, EvalContext};
use crate::AppState;
use rusqlite::params;
use std::collections::HashMap;
use tauri::State;

/// Returns all data the frontend Web Worker needs to render financial statements.
/// The frontend handles DOM construction; Rust just aggregates numbers.
#[tauri::command]
pub async fn render_report_data(
    state: State<'_, AppState>,
) -> std::result::Result<ReportData, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    // Engagement metadata
    let engagement = db.conn.query_row(
        &format!("SELECT {ENGAGEMENT_COLUMNS} FROM engagement LIMIT 1"),
        [],
        |r| map_engagement_row(r, db.path.clone()),
    )?;

    // Map totals: current & prior, plus AJE-adjusted current
    let mut stmt = db.conn.prepare_cached(
        "SELECT
             m.code,
             m.label,
             COALESCE(SUM(a.current_balance), 0.0) AS current_total,
             COALESCE(SUM(a.prior_balance), 0.0)   AS prior_total,
             COALESCE(SUM(
                 a.current_balance + COALESCE((
                     SELECT SUM(l.debit - l.credit)
                     FROM aje_lines l JOIN ajes j ON j.id = l.aje_id
                     WHERE l.account_number = a.account_number AND j.is_voided = 0
                 ), 0.0)
             ), 0.0) AS adjusted_current
         FROM map_numbers m
         LEFT JOIN tb_accounts a ON a.map_number = m.code
         GROUP BY m.code
         ORDER BY m.sort_order, m.code",
    )?;

    let map_totals: Vec<MapTotal> = stmt
        .query_map([], |r| {
            Ok(MapTotal {
                map_number: r.get(0)?,
                label: r.get(1)?,
                current_total: r.get(2)?,
                prior_total: r.get(3)?,
                adjusted_current: r.get(4)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;

    // Custom variables
    let mut var_stmt = db
        .conn
        .prepare_cached("SELECT key, value, description FROM custom_vars ORDER BY key")?;
    let custom_vars: Vec<CustomVar> = var_stmt
        .query_map([], |r| {
            Ok(CustomVar {
                key: r.get(0)?,
                value: r.get(1)?,
                description: r.get(2)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;

    Ok(ReportData {
        engagement,
        map_totals,
        custom_vars,
    })
}

// ════════════════════════════════════════════════════════════════════════════
//  Programmable report engine
// ════════════════════════════════════════════════════════════════════════════

fn fetch_engagement(db: &crate::db::AppDb) -> Result<EngagementMeta> {
    Ok(db.conn.query_row(
        &format!("SELECT {ENGAGEMENT_COLUMNS} FROM engagement LIMIT 1"),
        [],
        |r| map_engagement_row(r, db.path.clone()),
    )?)
}

/// All map totals keyed by code, for both axes, plus the sorted code list.
fn fetch_axis_maps(
    db: &crate::db::AppDb,
) -> Result<(HashMap<String, f64>, HashMap<String, f64>, Vec<String>)> {
    let mut stmt = db.conn.prepare_cached(
        "SELECT
             m.code,
             COALESCE(SUM(
                 a.current_balance + COALESCE((
                     SELECT SUM(l.debit - l.credit)
                     FROM aje_lines l JOIN ajes j ON j.id = l.aje_id
                     WHERE l.account_number = a.account_number AND j.is_voided = 0
                 ), 0.0)
             ), 0.0) AS adjusted_current,
             COALESCE(SUM(a.prior_balance), 0.0) AS prior_total
         FROM map_numbers m
         LEFT JOIN tb_accounts a ON a.map_number = m.code
         GROUP BY m.code
         ORDER BY m.sort_order, m.code",
    )?;
    let mut current = HashMap::new();
    let mut prior = HashMap::new();
    let mut codes = Vec::new();
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?))
    })?;
    for row in rows {
        let (code, cur, pri) = row?;
        current.insert(code.clone(), cur);
        prior.insert(code.clone(), pri);
        codes.push(code);
    }
    codes.sort();
    Ok((current, prior, codes))
}

/// Per-axis grouping totals (sum of member accounts) keyed by grouping id as string.
/// Current axis is AJE-adjusted to match map totals.
fn fetch_group_maps(
    db: &crate::db::AppDb,
) -> Result<(HashMap<String, f64>, HashMap<String, f64>)> {
    let mut stmt = db.conn.prepare_cached(
        "SELECT
             ag.grouping_id,
             COALESCE(SUM(
                 a.current_balance + COALESCE((
                     SELECT SUM(l.debit - l.credit)
                     FROM aje_lines l JOIN ajes j ON j.id = l.aje_id
                     WHERE l.account_number = a.account_number AND j.is_voided = 0
                 ), 0.0)
             ), 0.0) AS adjusted_current,
             COALESCE(SUM(a.prior_balance), 0.0) AS prior_total
         FROM account_groupings ag
         JOIN tb_accounts a ON a.id = ag.account_id
         GROUP BY ag.grouping_id",
    )?;
    let mut current = HashMap::new();
    let mut prior = HashMap::new();
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?))
    })?;
    for row in rows {
        let (id, cur, pri) = row?;
        current.insert(id.to_string(), cur);
        prior.insert(id.to_string(), pri);
    }
    Ok((current, prior))
}

/// Per-axis account balances keyed by account_number. Current axis is AJE-adjusted.
fn fetch_account_maps(
    db: &crate::db::AppDb,
) -> Result<(HashMap<String, f64>, HashMap<String, f64>)> {
    let mut stmt = db.conn.prepare_cached(
        "SELECT
             a.account_number,
             a.current_balance + COALESCE((
                 SELECT SUM(l.debit - l.credit)
                 FROM aje_lines l JOIN ajes j ON j.id = l.aje_id
                 WHERE l.account_number = a.account_number AND j.is_voided = 0
             ), 0.0) AS adjusted_current,
             a.prior_balance
         FROM tb_accounts a",
    )?;
    let mut current = HashMap::new();
    let mut prior = HashMap::new();
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?))
    })?;
    for row in rows {
        let (acct, cur, pri) = row?;
        current.insert(acct.clone(), cur);
        prior.insert(acct, pri);
    }
    Ok((current, prior))
}

fn fetch_vars(db: &crate::db::AppDb) -> Result<HashMap<String, String>> {
    let mut stmt = db.conn.prepare_cached("SELECT key, value FROM custom_vars")?;
    let mut map = HashMap::new();
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (k, v) = row?;
        map.insert(k, v);
    }
    Ok(map)
}

fn fetch_statement_lines(db: &crate::db::AppDb, statement_id: i64) -> Result<Vec<StatementLine>> {
    let mut stmt = db.conn.prepare_cached(
        "SELECT id, statement_id, parent_id, line_no, sort_order, line_type,
                label, expression, bold, underline, show_prior, invert_sign
         FROM statement_lines WHERE statement_id = ?1
         ORDER BY sort_order, id",
    )?;
    let lines = stmt
        .query_map(params![statement_id], |r| {
            Ok(StatementLine {
                id: r.get(0)?,
                statement_id: r.get(1)?,
                parent_id: r.get(2)?,
                line_no: r.get(3)?,
                sort_order: r.get(4)?,
                line_type: r.get(5)?,
                label: r.get(6)?,
                expression: r.get(7)?,
                bold: r.get::<_, i32>(8)? != 0,
                underline: r.get::<_, i32>(9)? != 0,
                show_prior: r.get::<_, i32>(10)? != 0,
                invert_sign: r.get::<_, i32>(11)? != 0,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(lines)
}

#[tauri::command]
pub async fn list_statements(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<Statement>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let mut stmt = db
        .conn
        .prepare("SELECT id, name, kind, sort_order FROM statements ORDER BY sort_order, id")?;
    let metas = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i32>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut out = Vec::with_capacity(metas.len());
    for (id, name, kind, sort_order) in metas {
        let lines = fetch_statement_lines(db, id)?;
        out.push(Statement { id, name, kind, sort_order, lines });
    }
    Ok(out)
}

/// Resolve a statement into concrete amounts. The core of the engine.
#[tauri::command]
pub async fn resolve_statement(
    statement_id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<ResolvedStatement, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let engagement = fetch_engagement(db)?;
    let (cur_maps, pri_maps, codes) = fetch_axis_maps(db)?;
    let (cur_groups, pri_groups) = fetch_group_maps(db)?;
    let (cur_accts, pri_accts) = fetch_account_maps(db)?;
    let vars = fetch_vars(db)?;

    let (name, kind): (String, String) = db.conn.query_row(
        "SELECT name, kind FROM statements WHERE id = ?1",
        params![statement_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    let lines = fetch_statement_lines(db, statement_id)?;

    // Build the note registry once (not per-line — see E1). Cheap if no labels
    // reference notes; expand_note_refs short-circuits on labels without tags.
    let note_registry = build_global_note_map(db);

    // Depth lookup from parent chain.
    let parent_of: HashMap<i64, Option<i64>> =
        lines.iter().map(|l| (l.id, l.parent_id)).collect();
    let id_to_lineno: HashMap<i64, i64> = lines.iter().map(|l| (l.id, l.line_no)).collect();
    let depth_of = |mut id: i64| -> i32 {
        let mut d = 0;
        while let Some(Some(p)) = parent_of.get(&id) {
            d += 1;
            id = *p;
        }
        d
    };

    // Children's resolved values (by parent line_no) for SUBTOTAL summation.
    let mut child_current: HashMap<i64, f64> = HashMap::new();
    let mut child_prior: HashMap<i64, f64> = HashMap::new();

    // line_no -> computed value, per axis (built top-down so L: refs resolve).
    let mut cur_vals: HashMap<i64, f64> = HashMap::new();
    let mut pri_vals: HashMap<i64, f64> = HashMap::new();

    let mut resolved = Vec::with_capacity(lines.len());

    for line in &lines {
        let depth = depth_of(line.id);
        let parent_lineno = line.parent_id.and_then(|p| id_to_lineno.get(&p).copied());

        let mut current: Option<f64> = None;
        let mut prior: Option<f64> = None;
        let mut text: Option<String> = None;
        let mut error: Option<String> = None;

        match line.line_type.as_str() {
            "HEADER" | "SPACER" => {}
            "VAR" => {
                if let Some(expr) = &line.expression {
                    let key = expr.trim().strip_prefix("V:").unwrap_or(expr.trim());
                    text = vars.get(key).cloned().or(Some(String::new()));
                }
            }
            "MAP" | "FORMULA" => {
                let expr = line.expression.clone().unwrap_or_default();
                let cur_ctx = EvalContext {
                    map_totals: &cur_maps, map_codes: &codes,
                    group_totals: &cur_groups, account_totals: &cur_accts,
                    line_values: &cur_vals, vars: &vars,
                };
                let pri_ctx = EvalContext {
                    map_totals: &pri_maps, map_codes: &codes,
                    group_totals: &pri_groups, account_totals: &pri_accts,
                    line_values: &pri_vals, vars: &vars,
                };
                match (eval(&expr, &cur_ctx), eval(&expr, &pri_ctx)) {
                    (Ok(c), Ok(p)) => {
                        let (c, p) = if line.invert_sign { (-c, -p) } else { (c, p) };
                        current = Some(c);
                        prior = Some(p);
                    }
                    (Err(e), _) | (_, Err(e)) => error = Some(e),
                }
            }
            "SUBTOTAL" => {
                let (c, p) = if let Some(expr) = &line.expression {
                    // Explicit override expression.
                    let cur_ctx = EvalContext {
                        map_totals: &cur_maps, map_codes: &codes,
                        group_totals: &cur_groups, account_totals: &cur_accts,
                        line_values: &cur_vals, vars: &vars,
                    };
                    let pri_ctx = EvalContext {
                        map_totals: &pri_maps, map_codes: &codes,
                        group_totals: &pri_groups, account_totals: &pri_accts,
                        line_values: &pri_vals, vars: &vars,
                    };
                    match (eval(expr, &cur_ctx), eval(expr, &pri_ctx)) {
                        (Ok(c), Ok(p)) => (c, p),
                        (Err(e), _) | (_, Err(e)) => { error = Some(e); (0.0, 0.0) }
                    }
                } else {
                    // Sum of immediate children accumulated so far.
                    (
                        *child_current.get(&line.line_no).unwrap_or(&0.0),
                        *child_prior.get(&line.line_no).unwrap_or(&0.0),
                    )
                };
                let (c, p) = if line.invert_sign { (-c, -p) } else { (c, p) };
                current = Some(c);
                prior = Some(p);
            }
            other => error = Some(format!("Unknown line type '{other}'")),
        }

        // Record this line's value so L: refs and parent SUBTOTALs can use it.
        if let (Some(c), Some(p)) = (current, prior) {
            cur_vals.insert(line.line_no, c);
            pri_vals.insert(line.line_no, p);
            if let Some(pl) = parent_lineno {
                *child_current.entry(pl).or_insert(0.0) += c;
                *child_prior.entry(pl).or_insert(0.0) += p;
            }
        }

        resolved.push(ResolvedLine {
            line_no: line.line_no,
            depth,
            line_type: line.line_type.clone(),
            label: expand_note_refs(&line.label, &note_registry),
            current,
            prior,
            text,
            bold: line.bold,
            underline: line.underline,
            show_prior: line.show_prior,
            error,
        });
    }

    Ok(ResolvedStatement { id: statement_id, name, kind, engagement, lines: resolved })
}

#[derive(Debug, serde::Deserialize)]
pub struct UpsertStatementPayload {
    pub id: Option<i64>,
    pub name: String,
    pub kind: String,
}

#[tauri::command]
pub async fn upsert_statement(
    payload: UpsertStatementPayload,
    state: State<'_, AppState>,
) -> std::result::Result<i64, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;

    if let Some(id) = payload.id {
        db.conn.execute(
            "UPDATE statements SET name = ?1, kind = ?2 WHERE id = ?3",
            params![payload.name, payload.kind, id],
        )?;
        Ok(id)
    } else {
        let next_sort: i64 = db.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM statements",
            [],
            |r| r.get(0),
        )?;
        db.conn.execute(
            "INSERT INTO statements (name, kind, sort_order) VALUES (?1, ?2, ?3)",
            params![payload.name, payload.kind, next_sort],
        )?;
        Ok(db.conn.last_insert_rowid())
    }
}

#[tauri::command]
pub async fn delete_statement(
    id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    db.conn.execute("DELETE FROM statements WHERE id = ?1", params![id])?;
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
pub struct UpsertLinePayload {
    pub id: Option<i64>,
    pub statement_id: i64,
    pub parent_id: Option<i64>,
    pub line_type: String,
    pub label: String,
    pub expression: Option<String>,
    pub bold: bool,
    pub underline: bool,
    pub show_prior: bool,
    pub invert_sign: bool,
}

#[tauri::command]
pub async fn upsert_statement_line(
    payload: UpsertLinePayload,
    state: State<'_, AppState>,
) -> std::result::Result<i64, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;

    if let Some(id) = payload.id {
        db.conn.execute(
            "UPDATE statement_lines
             SET parent_id = ?1, line_type = ?2, label = ?3, expression = ?4,
                 bold = ?5, underline = ?6, show_prior = ?7, invert_sign = ?8
             WHERE id = ?9",
            params![
                payload.parent_id, payload.line_type, payload.label, payload.expression,
                payload.bold as i32, payload.underline as i32,
                payload.show_prior as i32, payload.invert_sign as i32, id
            ],
        )?;
        Ok(id)
    } else {
        let next_sort: i64 = db.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM statement_lines WHERE statement_id = ?1",
            params![payload.statement_id],
            |r| r.get(0),
        )?;
        let next_lineno: i64 = db.conn.query_row(
            "SELECT COALESCE(MAX(line_no), 0) + 1 FROM statement_lines WHERE statement_id = ?1",
            params![payload.statement_id],
            |r| r.get(0),
        )?;
        db.conn.execute(
            "INSERT INTO statement_lines
             (statement_id, parent_id, line_no, sort_order, line_type, label,
              expression, bold, underline, show_prior, invert_sign)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                payload.statement_id, payload.parent_id, next_lineno, next_sort,
                payload.line_type, payload.label, payload.expression,
                payload.bold as i32, payload.underline as i32,
                payload.show_prior as i32, payload.invert_sign as i32
            ],
        )?;
        Ok(db.conn.last_insert_rowid())
    }
}

#[tauri::command]
pub async fn delete_statement_line(
    id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    db.conn.execute("DELETE FROM statement_lines WHERE id = ?1", params![id])?;
    Ok(())
}

/// Reorder a statement's lines. `ordered_ids` is the new top-to-bottom order.
#[tauri::command]
pub async fn reorder_statement_lines(
    ordered_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let mut guard = state.db.lock().unwrap();
    let db = guard.as_mut().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    db.transaction(|conn| {
        for (i, id) in ordered_ids.iter().enumerate() {
            conn.execute(
                "UPDATE statement_lines SET sort_order = ?1 WHERE id = ?2",
                params![i as i64, id],
            )?;
        }
        Ok(())
    })?;
    Ok(())
}

/// Create the four standard statements as editable templates if none exist yet.
/// Returns the number of statements created (0 if they already existed).
#[tauri::command]
pub async fn seed_default_statements(
    state: State<'_, AppState>,
) -> std::result::Result<usize, AppError> {
    let mut guard = state.db.lock().unwrap();
    let db = guard.as_mut().ok_or(AppError::NoEngagementOpen)?;

    let existing: i64 =
        db.conn.query_row("SELECT COUNT(*) FROM statements", [], |r| r.get(0))?;
    if existing > 0 {
        return Ok(0);
    }

    // Each template line: (line_type, label, expression, bold, underline, invert)
    type L<'a> = (&'a str, &'a str, Option<&'a str>, bool, bool, bool);

    let balance_sheet: Vec<L> = vec![
        ("HEADER", "ASSETS", None, true, false, false),
        ("HEADER", "Current Assets", None, false, false, false),
        ("MAP", "Cash & Equivalents", Some("SUM(1000..1099)"), false, false, false),
        ("MAP", "Accounts Receivable", Some("SUM(1100..1199)"), false, false, false),
        ("MAP", "Inventory", Some("SUM(1200..1299)"), false, false, false),
        ("SUBTOTAL", "Total Current Assets", Some("SUM(1000..1499)"), true, true, false),
        ("MAP", "Property, Plant & Equipment", Some("SUM(1500..1799)"), false, false, false),
        ("MAP", "Other Non-Current Assets", Some("SUM(1800..1999)"), false, false, false),
        ("SUBTOTAL", "TOTAL ASSETS", Some("SUM(1000..1999)"), true, true, false),
        ("SPACER", "", None, false, false, false),
        ("HEADER", "LIABILITIES & EQUITY", None, true, false, false),
        ("MAP", "Current Liabilities", Some("SUM(2000..2499)"), false, false, true),
        ("MAP", "Long-Term Liabilities", Some("SUM(2500..2999)"), false, false, true),
        ("SUBTOTAL", "Total Liabilities", Some("SUM(2000..2999)"), true, false, true),
        ("MAP", "Equity", Some("SUM(3000..3999)"), false, false, true),
        ("SUBTOTAL", "TOTAL LIABILITIES & EQUITY", Some("SUM(2000..3999)"), true, true, true),
    ];

    let income_statement: Vec<L> = vec![
        ("MAP", "Revenue", Some("SUM(4000..4999)"), false, false, true),
        ("MAP", "Cost of Goods Sold", Some("SUM(5000..5499)"), false, false, false),
        ("SUBTOTAL", "Gross Profit", Some("SUM(4000..4999) - SUM(5000..5499) * -1"), true, true, false),
        ("MAP", "Operating Expenses", Some("SUM(5500..6999)"), false, false, false),
        ("MAP", "Other Income / (Expense)", Some("SUM(7000..7999)"), false, false, true),
        ("SUBTOTAL", "NET INCOME", Some("SUM(4000..4999) - SUM(5000..6999) + SUM(7000..7999)"), true, true, true),
    ];

    let cash_flow: Vec<L> = vec![
        ("HEADER", "Operating Activities", None, true, false, false),
        ("MAP", "Net Income", Some("SUM(4000..4999) - SUM(5000..6999) + SUM(7000..7999)"), false, false, true),
        ("MAP", "Depreciation & Amortization", Some("SUM(6000..6099)"), false, false, false),
        ("SUBTOTAL", "Cash from Operations", None, true, true, false),
        ("SPACER", "", None, false, false, false),
        ("HEADER", "Investing Activities", None, true, false, false),
        ("MAP", "Capital Expenditures", Some("SUM(1500..1799)"), false, false, false),
        ("SUBTOTAL", "Cash from Investing", None, true, true, false),
        ("SPACER", "", None, false, false, false),
        ("HEADER", "Financing Activities", None, true, false, false),
        ("MAP", "Debt & Equity Movements", Some("SUM(2500..3999)"), false, false, false),
        ("SUBTOTAL", "Cash from Financing", None, true, true, false),
    ];

    let equity: Vec<L> = vec![
        ("MAP", "Opening Equity (Prior)", Some("SUM(3000..3499)"), false, false, true),
        ("MAP", "Net Income for the Year", Some("SUM(4000..4999) - SUM(5000..6999) + SUM(7000..7999)"), false, false, true),
        ("MAP", "Distributions / Dividends", Some("SUM(3500..3999)"), false, false, false),
        ("SUBTOTAL", "Closing Equity", None, true, true, false),
    ];

    let templates: Vec<(&str, &str, Vec<L>)> = vec![
        ("Balance Sheet", "BALANCE_SHEET", balance_sheet),
        ("Income Statement", "INCOME_STATEMENT", income_statement),
        ("Statement of Cash Flows", "CASH_FLOW", cash_flow),
        ("Statement of Equity", "EQUITY", equity),
    ];

    let count = templates.len();
    db.transaction(|conn| {
        for (si, (name, kind, lines)) in templates.iter().enumerate() {
            conn.execute(
                "INSERT INTO statements (name, kind, sort_order) VALUES (?1, ?2, ?3)",
                params![name, kind, si as i64],
            )?;
            let stmt_id = conn.last_insert_rowid();
            for (li, (lt, label, expr, bold, underline, invert)) in lines.iter().enumerate() {
                conn.execute(
                    "INSERT INTO statement_lines
                     (statement_id, parent_id, line_no, sort_order, line_type, label,
                      expression, bold, underline, show_prior, invert_sign)
                     VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)",
                    params![
                        stmt_id, (li + 1) as i64, li as i64, lt, label, expr,
                        *bold as i32, *underline as i32, *invert as i32
                    ],
                )?;
            }
        }
        Ok(())
    })?;

    Ok(count)
}

/// Build a global note number map by scanning all template bodies for
/// `{{note_def:key}}` tags in sort order. This is package-independent so
/// statement labels can reference notes without a prior package render.
fn build_global_note_map(db: &crate::db::AppDb) -> HashMap<String, i64> {
    let mut map: HashMap<String, i64> = HashMap::new();
    let mut counter: i64 = 1;
    // Pull all template bodies ordered by id (stable insertion order).
    let Ok(mut stmt) = db.conn.prepare_cached(
        "SELECT body_html FROM doc_templates ORDER BY id"
    ) else { return map; };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else { return map; };
    for body in rows.flatten() {
        let mut remaining = body.as_str();
        while let Some(start) = remaining.find("{{") {
            remaining = &remaining[start + 2..];
            if let Some(end) = remaining.find("}}") {
                let tag = remaining[..end].trim();
                remaining = &remaining[end + 2..];
                let key = if let Some(k) = tag.strip_prefix("note_def:") {
                    k.split('|').next().unwrap_or("").trim()
                } else {
                    continue;
                };
                if !key.is_empty() && !map.contains_key(key) {
                    map.insert(key.to_string(), counter);
                    counter += 1;
                }
            }
        }
    }
    map
}

/// Replace `{{note_ref:key}}` tags in a label with "Note N".
/// `registry` is the pre-built note map (see `build_global_note_map`); pass it
/// in so callers in a loop don't rebuild it per line.
fn expand_note_refs(label: &str, registry: &HashMap<String, i64>) -> String {
    if !label.contains("{{note_ref:") {
        return label.to_string();
    }
    let mut out = String::new();
    let mut remaining = label;
    while let Some(start) = remaining.find("{{") {
        out.push_str(&remaining[..start]);
        remaining = &remaining[start + 2..];
        if let Some(end) = remaining.find("}}") {
            let tag = remaining[..end].trim();
            remaining = &remaining[end + 2..];
            if let Some(key_raw) = tag.strip_prefix("note_ref:") {
                // Strip any |modifier suffix (e.g. |inline) before looking up the key.
                let key = key_raw.split('|').next().unwrap_or(key_raw).trim();
                if let Some(&n) = registry.get(key) {
                    out.push_str(&format!("Note {n}"));
                } else {
                    out.push_str(&format!("Note {key}?"));
                }
            } else {
                out.push_str(&format!("{{{{{tag}}}}}"));
            }
        } else {
            out.push_str("{{");
        }
    }
    out.push_str(remaining);
    out
}

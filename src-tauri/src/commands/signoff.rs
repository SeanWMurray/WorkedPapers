use crate::db::AppDb;
use crate::error::{AppError, Result};
use crate::models::{AuditEntry, Signoff, SignoffRole};
use crate::AppState;
use chrono::{DateTime, Utc};
use rusqlite::params;
use sha2::{Digest, Sha256};
use tauri::State;

#[tauri::command]
pub async fn sign_off(
    scope: String,
    role: String,
    signed_by: String,
    signed_initials: String,
    state: State<'_, AppState>,
) -> std::result::Result<i64, AppError> {
    let mut guard = state.db.lock().unwrap();
    let db = guard.as_mut().ok_or(AppError::NoEngagementOpen)?;

    db.ensure_unlocked()?;

    let now = Utc::now().to_rfc3339();
    let hash_input = format!("{scope}|{role}|{signed_by}|{now}");
    let hash = format!("{:x}", Sha256::digest(hash_input.as_bytes()));

    db.transaction(|conn| {
        conn.execute(
            "INSERT INTO signoffs (scope, role, signed_by, signed_initials, signed_at, signature_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![scope, role.to_uppercase(), signed_by, signed_initials.to_uppercase(), now, hash],
        )?;
        let id = conn.last_insert_rowid();

        AppDb::audit(
            conn,
            "SIGN_OFF",
            "signoffs",
            &id.to_string(),
            &signed_by,
            &serde_json::json!({ "scope": scope, "role": role }),
        )?;

        Ok(id)
    })
}

#[tauri::command]
pub async fn get_signoffs(
    scope: Option<String>,
    state: State<'_, AppState>,
) -> std::result::Result<Vec<Signoff>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let signoffs: Vec<Signoff> = if let Some(s) = scope {
        let mut stmt = db.conn.prepare(
            "SELECT id, scope, role, signed_by, signed_initials, signed_at, signature_hash
             FROM signoffs WHERE scope = ?1 ORDER BY signed_at",
        )?;
        let rows = stmt.query_map(params![s], map_signoff)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    } else {
        let mut stmt = db.conn.prepare(
            "SELECT id, scope, role, signed_by, signed_initials, signed_at, signature_hash
             FROM signoffs ORDER BY signed_at",
        )?;
        let rows = stmt.query_map([], map_signoff)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };

    Ok(signoffs)
}

/// Cryptographically seal the engagement — no edits allowed after this.
/// The seal hash covers all material financial data so tampering is detectable.
#[tauri::command]
pub async fn lock_engagement(
    locked_by: String,
    state: State<'_, AppState>,
) -> std::result::Result<String, AppError> {
    let mut guard = state.db.lock().unwrap();
    let db = guard.as_mut().ok_or(AppError::NoEngagementOpen)?;

    let now = Utc::now().to_rfc3339();
    let seal_hash = compute_content_hash(&db.conn)?;

    db.transaction(|conn| {
        conn.execute(
            "UPDATE engagement SET is_locked = 1, lock_hash = ?1, locked_by = ?2, locked_at = ?3, updated_at = ?3",
            params![seal_hash, locked_by, now],
        )?;

        AppDb::audit(
            conn,
            "LOCK_ENGAGEMENT",
            "engagement",
            "global",
            &locked_by,
            &serde_json::json!({ "lock_hash": seal_hash }),
        )?;

        Ok(seal_hash)
    })
}

/// Recompute the content hash and compare against the stored seal.
/// Returns the stored hash if it matches, or an error describing the mismatch.
#[tauri::command]
pub async fn verify_integrity(
    state: State<'_, AppState>,
) -> std::result::Result<String, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let stored_hash: Option<String> = db.conn.query_row(
        "SELECT lock_hash FROM engagement LIMIT 1",
        [],
        |r| r.get(0),
    )?;

    let stored_hash = stored_hash.ok_or_else(|| {
        AppError::Other("Engagement has not been locked — no seal hash to verify".into())
    })?;

    let current_hash = compute_content_hash(&db.conn)?;

    if current_hash == stored_hash {
        Ok(stored_hash)
    } else {
        Err(AppError::Other(format!(
            "Integrity check FAILED.\nStored:  {stored_hash}\nCurrent: {current_hash}\nThe engagement data has been modified after locking."
        )))
    }
}

/// SHA-256 over all material financial data rows, in deterministic order.
fn compute_content_hash(conn: &rusqlite::Connection) -> std::result::Result<String, AppError> {
    let mut hasher = Sha256::new();

    // Trial balance accounts + balances
    {
        let mut stmt = conn.prepare(
            "SELECT account_number, account_name, current_balance, prior_balance, map_number
             FROM tb_accounts ORDER BY account_number",
        )?;
        stmt.query_map([], |r| {
            Ok(format!(
                "TB|{}|{}|{}|{}|{}\n",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, f64>(3)?,
                r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            ))
        })?
        .try_for_each(|r| -> std::result::Result<(), AppError> {
            hasher.update(r?.as_bytes());
            Ok(())
        })?;
    }

    // AJE headers
    {
        let mut stmt = conn.prepare(
            "SELECT id, entry_type, description, posted_at, is_voided
             FROM ajes ORDER BY id",
        )?;
        stmt.query_map([], |r| {
            Ok(format!(
                "AJE|{}|{}|{}|{}|{}\n",
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?
        .try_for_each(|r| -> std::result::Result<(), AppError> {
            hasher.update(r?.as_bytes());
            Ok(())
        })?;
    }

    // AJE lines
    {
        let mut stmt = conn.prepare(
            "SELECT aje_id, account_number, debit, credit
             FROM aje_lines ORDER BY aje_id, id",
        )?;
        stmt.query_map([], |r| {
            Ok(format!(
                "AJELINE|{}|{}|{}|{}\n",
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, f64>(3)?,
            ))
        })?
        .try_for_each(|r| -> std::result::Result<(), AppError> {
            hasher.update(r?.as_bytes());
            Ok(())
        })?;
    }

    // Map numbers
    {
        let mut stmt = conn.prepare(
            "SELECT code, label, parent_code, sort_order FROM map_numbers ORDER BY code",
        )?;
        stmt.query_map([], |r| {
            Ok(format!(
                "MAP|{}|{}|{}|{}\n",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                r.get::<_, i64>(3)?,
            ))
        })?
        .try_for_each(|r| -> std::result::Result<(), AppError> {
            hasher.update(r?.as_bytes());
            Ok(())
        })?;
    }

    // Engagement header
    {
        let row: String = conn.query_row(
            "SELECT entity_name || '|' || year_end || '|' || fiscal_year || '|' || currency
             FROM engagement LIMIT 1",
            [],
            |r| r.get(0),
        )?;
        hasher.update(format!("ENG|{row}\n").as_bytes());
    }

    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
pub async fn get_audit_trail(
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> std::result::Result<Vec<AuditEntry>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let limit = limit.unwrap_or(500);

    let mut stmt = db.conn.prepare_cached(
        "SELECT id, action, entity, entity_id, performed_by, performed_at, detail
         FROM audit_trail ORDER BY performed_at DESC LIMIT ?1",
    )?;

    let entries = stmt
        .query_map(params![limit], |r| {
            let performed_at = crate::models::parse_db_datetime(&r.get::<_, String>(5)?);
            let detail = serde_json::from_str(&r.get::<_, String>(6)?)
                .unwrap_or(serde_json::Value::Null);
            Ok(AuditEntry {
                id: r.get(0)?,
                action: r.get(1)?,
                entity: r.get(2)?,
                entity_id: r.get(3)?,
                performed_by: r.get(4)?,
                performed_at,
                detail,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;

    Ok(entries)
}

#[tauri::command]
pub async fn remove_signoff(
    id: i64,
    removed_by: String,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let mut guard = state.db.lock().unwrap();
    let db = guard.as_mut().ok_or(AppError::NoEngagementOpen)?;

    db.ensure_unlocked()?;

    db.transaction(|conn| {
        let rows = conn.execute("DELETE FROM signoffs WHERE id = ?1", params![id])?;
        if rows > 0 {
            AppDb::audit(
                conn,
                "REMOVE_SIGN_OFF",
                "signoffs",
                &id.to_string(),
                &removed_by,
                &serde_json::json!({ "id": id }),
            )?;
        }
        Ok(())
    })
}

fn map_signoff(r: &rusqlite::Row<'_>) -> rusqlite::Result<Signoff> {
    let role_str: String = r.get(2)?;
    let role = match role_str.to_uppercase().as_str() {
        "REVIEWER" => SignoffRole::Reviewer,
        "PARTNER" => SignoffRole::Partner,
        _ => SignoffRole::Preparer,
    };
    let signed_at_str: String = r.get(5)?;
    let signed_at = signed_at_str
        .parse::<DateTime<Utc>>()
        .unwrap_or_else(|_| Utc::now());
    Ok(Signoff {
        id: r.get(0)?,
        scope: r.get(1)?,
        role,
        signed_by: r.get(3)?,
        signed_initials: r.get(4)?,
        signed_at,
        signature_hash: r.get(6)?,
    })
}

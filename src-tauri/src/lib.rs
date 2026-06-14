mod commands;
mod db;
mod error;
mod models;
mod report_engine;
mod wwp;

use db::AppDb;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<Option<AppDb>>,
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            db: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            // Engagement lifecycle
            commands::engagement::open_engagement,
            commands::engagement::create_engagement,
            commands::engagement::close_engagement,
            commands::engagement::get_engagement_meta,
            // Trial Balance
            commands::trial_balance::import_tb_csv,
            commands::trial_balance::get_tb_accounts,
            commands::trial_balance::update_account_mapping,
            commands::trial_balance::update_account_meta,
            commands::trial_balance::update_account_balance,
            commands::trial_balance::create_account,
            commands::trial_balance::get_tb_summary,
            // Adjusting Journal Entries
            commands::aje::list_ajes,
            commands::aje::post_aje,
            commands::aje::void_aje,
            commands::aje::get_aje_impact,
            // Mapping & Groupings
            commands::mapping::list_map_numbers,
            commands::mapping::upsert_map_number,
            commands::mapping::delete_map_number,
            commands::mapping::list_groupings,
            commands::mapping::upsert_grouping,
            commands::mapping::delete_grouping,
            commands::mapping::assign_grouping,
            // Leadsheets
            commands::leadsheet::get_leadsheet,
            commands::leadsheet::save_leadsheet_note,
            commands::leadsheet::add_tickmark,
            commands::leadsheet::remove_tickmark,
            // Sign-offs & Audit Trail
            commands::signoff::sign_off,
            commands::signoff::remove_signoff,
            commands::signoff::get_signoffs,
            commands::signoff::lock_engagement,
            commands::signoff::get_audit_trail,
            // Reports
            commands::reports::render_report_data,
            // Report engine (programmable statements)
            commands::reports::list_statements,
            commands::reports::resolve_statement,
            commands::reports::upsert_statement,
            commands::reports::delete_statement,
            commands::reports::upsert_statement_line,
            commands::reports::delete_statement_line,
            commands::reports::reorder_statement_lines,
            commands::reports::seed_default_statements,
            // File attachments (legacy flat)
            commands::files::list_attachments,
            commands::files::attach_file,
            commands::files::remove_attachment,
            commands::files::open_attachment,
            // File cabinet (virtual folder tree)
            commands::files::get_cabinet,
            commands::files::create_folder,
            commands::files::rename_folder,
            commands::files::delete_folder,
            commands::files::upsert_cabinet_item,
            commands::files::delete_cabinet_item,
            commands::files::move_cabinet_item,
            commands::files::move_cabinet_folder,
            // Document templates & packages
            commands::templates::upsert_doc_asset,
            commands::templates::list_doc_assets,
            commands::templates::delete_doc_asset,
            commands::templates::upsert_doc_template,
            commands::templates::list_doc_templates,
            commands::templates::get_doc_template,
            commands::templates::delete_doc_template,
            commands::templates::upsert_doc_package,
            commands::templates::list_doc_packages,
            commands::templates::delete_doc_package,
            commands::templates::upsert_package_item,
            commands::templates::list_package_items,
            commands::templates::reorder_package_items,
            commands::templates::delete_package_item,
            commands::templates::render_package,
            commands::templates::render_template,
            commands::templates::get_note_registry,
            commands::templates::list_all_note_keys,
            commands::templates::seed_default_templates,
            commands::templates::export_pdf,
            // Archive (.wwp)
            commands::archive::export_wwp,
            commands::archive::import_wwp,
            // Roll-Forward
            commands::rollforward::roll_forward,
            // User / Settings
            commands::settings::get_settings,
            commands::settings::save_settings,
        ])
        .setup(|app| {
            // Eagerly initialise the thread pool used for heavy Rust computations
            rayon::ThreadPoolBuilder::new()
                .num_threads(4)
                .build_global()
                .ok();

            #[cfg(debug_assertions)]
            {
                let window = app.get_window("main").unwrap();
                window.open_devtools();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

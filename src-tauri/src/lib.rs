mod commands;
mod db;
mod error;
mod models;
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
            commands::trial_balance::get_tb_summary,
            // Adjusting Journal Entries
            commands::aje::list_ajes,
            commands::aje::post_aje,
            commands::aje::void_aje,
            commands::aje::get_aje_impact,
            // Mapping & Groupings
            commands::mapping::list_map_numbers,
            commands::mapping::upsert_map_number,
            commands::mapping::list_groupings,
            commands::mapping::upsert_grouping,
            commands::mapping::assign_grouping,
            // Leadsheets
            commands::leadsheet::get_leadsheet,
            commands::leadsheet::save_leadsheet_note,
            commands::leadsheet::add_tickmark,
            commands::leadsheet::remove_tickmark,
            // Sign-offs & Audit Trail
            commands::signoff::sign_off,
            commands::signoff::get_signoffs,
            commands::signoff::lock_engagement,
            commands::signoff::get_audit_trail,
            // Reports
            commands::reports::render_report_data,
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

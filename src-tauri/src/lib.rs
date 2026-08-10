mod commands;

use commands::{github, misc, mod_discovery, project_io, scraper, secrets};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(scraper::ScraperState::default())
        .invoke_handler(tauri::generate_handler![
            project_io::project_exists,
            project_io::create_project_dir,
            project_io::load_project,
            project_io::save_project_file,
            project_io::read_text_file,
            project_io::save_text_file,
            project_io::read_file_b64,
            project_io::save_file_b64,
            project_io::store_player_profile,
            project_io::store_player_profile_b64,
            project_io::read_profile_file_b64,
            project_io::export_player_profile,
            project_io::delete_player_profile,
            project_io::read_player_profile_b64,
            project_io::write_player_profile_b64,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_has,
            secrets::secret_delete,
            github::github_test,
            github::github_get_file,
            github::github_put_file,
            github::github_me,
            github::github_repo_info,
            github::github_fork,
            github::github_create_branch,
            github::github_sync_branch,
            github::github_open_pr,
            github::github_put_file_b64,
            github::github_get_file_b64,
            scraper::scraper_start,
            scraper::scraper_cancel,
            scraper::scraper_running,
            misc::list_images,
            misc::discord_post,
            misc::wiki_fetch_page,
            mod_discovery::resolve_mods_root,
            mod_discovery::list_installed_mods,
            mod_discovery::read_installed_mods,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

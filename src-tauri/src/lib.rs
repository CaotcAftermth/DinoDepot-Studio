mod commands;

use commands::{
    app_state, git, github, github_setup, icon_cache, icon_import, misc, mod_assets, mod_discovery,
    package_http, package_library, project_io, project_lock, scraper, secrets,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Registered so the updater can relaunch after installing.
        .plugin(tauri_plugin_process::init())
        .manage(scraper::ScraperState::default())
        .manage(project_lock::LockState::default())
        .invoke_handler(tauri::generate_handler![
            project_io::project_exists,
            project_io::create_project_dir,
            project_io::load_project,
            project_io::save_project_file,
            project_io::quarantine_project_file,
            project_io::snapshot_project,
            project_io::commit_migrated_project,
            project_lock::project_lock_status,
            project_lock::project_lock_acquire,
            project_lock::project_lock_refresh,
            project_lock::project_lock_release,
            app_state::local_state_get,
            app_state::local_state_set,
            app_state::local_state_delete,
            app_state::local_state_list,
            app_state::delivery_dir,
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
            // Deliberately no `secret_get`: the frontend may learn that a
            // credential exists, never what it is.
            secrets::secret_set,
            secrets::secret_has,
            secrets::secret_delete,
            git::git_capabilities,
            git::git_state,
            git::git_read_tree,
            git::git_commit,
            git::git_set_remote,
            git::git_fetch,
            git::git_push,
            git::git_fast_forward,
            git::git_replace_dir,
            git::git_log,
            git::git_restore_files,
            git::git_mark_recovery,
            git::git_clear_recovery,
            github_setup::github_connect_account,
            github_setup::github_account_status,
            github_setup::github_disconnect_account,
            github_setup::github_repo_by_slug,
            github_setup::github_repo_by_id,
            github_setup::github_branch_exists,
            icon_cache::icon_fetch,
            icon_cache::icon_cache_get,
            icon_cache::icon_cache_put,
            icon_cache::icon_cache_stats,
            icon_cache::icon_cache_clear,
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
            package_http::package_http_get,
            package_library::package_library_install,
            package_library::package_library_list,
            package_library::package_library_read,
            icon_import::project_icon_write,
            mod_assets::mod_textures,
            mod_assets::mod_texture_png,
            package_library::package_bundled_manifest,
            package_library::package_library_install_bundled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

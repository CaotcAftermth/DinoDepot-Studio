use keyring::Entry;

/// Credential storage, backed by Windows Credential Manager.
///
/// The important property here is what is *missing*: there is no command that
/// returns a secret. `secret_get` used to be one, which meant the webview —
/// the part of the app that renders untrusted project content and talks to the
/// network — could ask for the GitHub token and get it. Now the token never
/// leaves Rust: the frontend asks for an *operation*, and this module hands the
/// credential to the HTTP or Git layer directly.
///
/// Credentials are filed per GitHub account rather than under one global key,
/// because an administrator can legitimately have more than one account and a
/// shared token is not supported.
const SERVICE: &str = "DinoDepotStudio";

/// The key the single-account build used. Read for the benefit of anyone
/// upgrading; never written.
pub const LEGACY_GITHUB_KEY: &str = "github-token";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

/// The credential key for a GitHub account id.
pub fn github_key(account_id: &str) -> String {
    format!("github-account:{account_id}")
}

/// Keys the frontend is allowed to name.
///
/// An allowlist rather than a sanitizer: the frontend has no business inventing
/// credential keys, and a fixed set means a compromised page cannot enumerate
/// or overwrite entries belonging to anything else on the machine.
fn is_allowed_key(key: &str) -> bool {
    if key == "discord-webhook" || key == LEGACY_GITHUB_KEY {
        return true;
    }
    match key.strip_prefix("github-account:") {
        Some(id) => {
            !id.is_empty()
                && id.len() <= 64
                && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        }
        None => false,
    }
}

fn check_key(key: &str) -> Result<(), String> {
    if is_allowed_key(key) {
        Ok(())
    } else {
        Err(format!("'{key}' is not a credential this app manages"))
    }
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    check_key(&key)?;
    if value.trim().is_empty() {
        return Err("A credential cannot be empty".into());
    }
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

/// Reads a secret. Deliberately **not** a Tauri command — see the module note.
pub fn secret_read(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Whether a credential exists. The only thing the frontend may learn about one.
#[tauri::command]
pub fn secret_has(key: String) -> Result<bool, String> {
    check_key(&key)?;
    Ok(secret_read(&key)?.is_some())
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    check_key(&key)?;
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// The GitHub token for an account, falling back to the pre-multi-account key.
///
/// The fallback is what stops an upgrade from silently logging everybody out;
/// it disappears once the account binding flow has run.
pub fn github_token(account_id: &str) -> Result<String, String> {
    if !account_id.is_empty() {
        if let Some(token) = secret_read(&github_key(account_id))? {
            return Ok(token);
        }
    }
    if let Some(token) = secret_read(LEGACY_GITHUB_KEY)? {
        return Ok(token);
    }
    Err("No GitHub sign-in stored — connect your GitHub account in Settings".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_keys_are_namespaced() {
        assert_eq!(github_key("12345"), "github-account:12345");
    }

    #[test]
    fn the_allowlist_covers_what_the_app_actually_stores() {
        assert!(is_allowed_key("discord-webhook"));
        assert!(is_allowed_key(LEGACY_GITHUB_KEY));
        assert!(is_allowed_key("github-account:1234567"));
        assert!(is_allowed_key("github-account:abc-DEF_9"));
    }

    /// The frontend must not be able to name an entry belonging to anything
    /// else, nor to sweep the store looking for one.
    #[test]
    fn anything_else_is_refused() {
        for bad in [
            "",
            "github-account:",
            "github-account:has space",
            "github-account:../../other",
            "*",
            "some-other-app-token",
            "GitHub-Account:1",
        ] {
            assert!(!is_allowed_key(bad), "{bad} should be refused");
        }
    }

    #[test]
    fn an_over_long_account_id_is_refused() {
        assert!(!is_allowed_key(&format!("github-account:{}", "1".repeat(65))));
    }

    #[test]
    fn empty_values_are_refused_rather_than_stored() {
        assert!(secret_set("discord-webhook".into(), "   ".into()).is_err());
    }
}

use serde::Serialize;

/// A failure the frontend can branch on.
///
/// Shared by the Git layer and the GitHub HTTP layer, because the two produce
/// the same *kinds* of problem - an expired credential, a repository that is
/// gone, a rate limit - and the retry logic upstream must not have to care
/// which of them raised it.
///
/// The codes match the TypeScript `StudioErrorCode` values exactly. Returning a
/// code rather than a sentence is what lets a caller tell "try again in a
/// moment" from "stop and ask the administrator" without reading English out of
/// an error string.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: String,
    /// Plain English, for the administrator. No status codes, no jargon.
    pub message: String,
    /// Technical text for Advanced Details. Redacted on construction.
    pub detail: String,
    /// Seconds GitHub asked us to wait. Absent unless it said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}

impl Failure {
    pub fn new(code: &str, message: &str, detail: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: redact(&detail.into()),
            retry_after_seconds: None,
        }
    }

    pub fn retry_after(mut self, seconds: Option<u64>) -> Self {
        self.retry_after_seconds = seconds;
        self
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Serialized, so the frontend receives a code rather than prose to parse.
        write!(
            f,
            "{}",
            serde_json::to_string(self).unwrap_or_else(|_| self.message.clone())
        )
    }
}

pub type Outcome<T> = Result<T, Failure>;

/// Strips anything credential-shaped from text on its way out.
///
/// Applied at construction rather than at each logging call site, because the
/// one place a token leaks is the place somebody forgot to call the redactor.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    // Rewrites `scheme://user:pass@host` to `scheme://«credentials»@host`.
    while let Some(at) = rest.find('@') {
        let (head, tail) = rest.split_at(at);
        match head.rfind("://") {
            Some(scheme_end) if head[scheme_end + 3..].contains(':') => {
                out.push_str(&head[..scheme_end + 3]);
                out.push_str("«credentials»");
            }
            _ => out.push_str(head),
        }
        out.push('@');
        rest = &tail[1..];
    }
    out.push_str(rest);

    for prefix in ["github_pat_", "ghp_", "gho_", "ghs_", "ghu_", "ghr_"] {
        while let Some(at) = out.find(prefix) {
            let end = out[at..]
                .char_indices()
                .find(|(i, c)| *i > 0 && !(c.is_ascii_alphanumeric() || *c == '_'))
                .map(|(i, _)| at + i)
                .unwrap_or(out.len());
            out.replace_range(at..end, "«token»");
        }
    }
    out
}

/// Turns an HTTP status into something an administrator can act on.
///
/// `what` names the thing being reached for - "the project repository" - so the
/// message reads as advice rather than as a status line.
pub fn classify_status(
    status: u16,
    what: &str,
    detail: impl Into<String>,
    retry_after: Option<u64>,
) -> Failure {
    let detail = detail.into();
    match status {
        401 => Failure::new(
            "auth.expired",
            "Your GitHub access has expired. Sign in again to continue.",
            detail,
        ),
        // GitHub uses 403 for secondary rate limits too, and says so with
        // Retry-After. Reading that as a bad token would send an administrator
        // off regenerating a credential that was fine.
        403 if retry_after.is_some() => Failure::new(
            "network.rateLimited",
            "GitHub is asking us to slow down. This will retry shortly.",
            detail,
        )
        .retry_after(retry_after),
        403 => Failure::new(
            "auth.forbidden",
            &format!(
                "Your GitHub access does not cover {what}. Check that the repository is in your token's list and that it grants Contents read and write."
            ),
            detail,
        ),
        404 => Failure::new(
            "repo.unavailable",
            &format!(
                "{} could not be found. It may have been deleted, renamed, or your access to it removed.",
                capitalize(what)
            ),
            detail,
        ),
        409 | 422 => Failure::new(
            "repo.conflict",
            &format!("{} is not in the state we expected. Nothing was changed.", capitalize(what)),
            detail,
        ),
        429 => Failure::new(
            "network.rateLimited",
            "GitHub is asking us to slow down. This will retry shortly.",
            detail,
        )
        .retry_after(retry_after),
        s if s >= 500 => Failure::new(
            "network.serverError",
            "GitHub is having trouble right now. Your work is saved on this computer - try again in a moment.",
            detail,
        ),
        _ => Failure::new(
            "unknown",
            &format!("GitHub refused the request for {what}."),
            detail,
        ),
    }
}

/// Classifies a transport failure - no connection, DNS, TLS, timeout.
pub fn classify_transport(error: &reqwest::Error, what: &str) -> Failure {
    if error.is_timeout() {
        return Failure::new(
            "network.timeout",
            "GitHub took too long to answer. Your work is saved on this computer.",
            format!("{what}: {error}"),
        );
    }
    Failure::new(
        "network.offline",
        "DinoDepot cannot reach GitHub right now. Your work is saved on this computer.",
        format!("{what}: {error}"),
    )
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_serializes_with_a_code_the_frontend_can_branch_on() {
        let text = Failure::new("repo.nonFastForward", "Somebody else saved first.", "x").to_string();
        assert!(text.contains("\"code\":\"repo.nonFastForward\""));
        assert!(text.contains("\"message\""));
    }

    #[test]
    fn retry_after_is_omitted_unless_github_said() {
        assert!(!Failure::new("unknown", "x", "y").to_string().contains("retryAfter"));
        assert!(Failure::new("network.rateLimited", "x", "y")
            .retry_after(Some(60))
            .to_string()
            .contains("\"retryAfterSeconds\":60"));
    }

    #[test]
    fn detail_is_redacted_on_construction() {
        let failure = Failure::new("unknown", "x", "url https://u:ghp_abcdefghijkl@github.com/o/r");
        assert!(!failure.detail.contains("ghp_"));
        assert!(!failure.detail.contains("u:"));
    }

    #[test]
    fn redaction_removes_every_token_shape() {
        assert_eq!(redact("token ghp_abcdefghijklmnopqrs failed"), "token «token» failed");
        assert_eq!(redact("github_pat_11ABCDEF0abcdefghij is bad"), "«token» is bad");
        assert_eq!(
            redact("connect https://x-access-token:secret@github.com/o/r.git"),
            "connect https://«credentials»@github.com/o/r.git"
        );
        // Ordinary text and an email address survive untouched.
        assert_eq!(redact("cannot reach github.com"), "cannot reach github.com");
        assert_eq!(redact("studio@dinodepot.invalid"), "studio@dinodepot.invalid");
    }

    #[test]
    fn statuses_map_to_the_codes_the_retry_logic_expects() {
        assert_eq!(classify_status(401, "the repository", "", None).code, "auth.expired");
        assert_eq!(classify_status(403, "the repository", "", None).code, "auth.forbidden");
        assert_eq!(classify_status(404, "the repository", "", None).code, "repo.unavailable");
        assert_eq!(classify_status(409, "the branch", "", None).code, "repo.conflict");
        assert_eq!(classify_status(422, "the branch", "", None).code, "repo.conflict");
        assert_eq!(classify_status(429, "the branch", "", None).code, "network.rateLimited");
        for status in [500, 502, 503] {
            assert_eq!(classify_status(status, "the branch", "", None).code, "network.serverError");
        }
    }

    /// The case that sends an administrator off regenerating a fine credential.
    #[test]
    fn a_403_carrying_retry_after_is_rate_limiting_not_a_bad_token() {
        let failure = classify_status(403, "the repository", "", Some(30));
        assert_eq!(failure.code, "network.rateLimited");
        assert_eq!(failure.retry_after_seconds, Some(30));
    }

    #[test]
    fn messages_never_mention_a_status_code() {
        for status in [401, 403, 404, 409, 422, 429, 500] {
            let message = classify_status(status, "the project repository", "", None).message;
            assert!(!message.contains(&status.to_string()), "{status}: {message}");
            assert!(!message.to_lowercase().contains("http"), "{status}: {message}");
        }
    }

    #[test]
    fn a_missing_repository_reads_as_a_sentence() {
        assert_eq!(
            classify_status(404, "the project repository", "", None).message,
            "The project repository could not be found. It may have been deleted, renamed, or your access to it removed."
        );
    }
}

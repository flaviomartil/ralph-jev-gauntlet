use crate::state::UpdateStatus;
use reqwest::header::{ACCEPT, HeaderMap, HeaderValue, USER_AGENT};
use serde::Deserialize;
use std::cmp::Ordering;
use std::time::Duration;

const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Deserialize)]
struct LatestRelease {
    tag_name: String,
    prerelease: bool,
}

pub async fn fetch_update_status() -> UpdateStatus {
    match fetch_latest_release_tag().await {
        Ok(Some(latest)) => match compare_versions(env!("CARGO_PKG_VERSION"), &latest) {
            Some(Ordering::Less) => UpdateStatus::Available { latest },
            Some(Ordering::Equal | Ordering::Greater) => UpdateStatus::UpToDate,
            None => UpdateStatus::Unknown,
        },
        Ok(None) => UpdateStatus::Unknown,
        Err(_) => UpdateStatus::Unknown,
    }
}

async fn fetch_latest_release_tag() -> Result<Option<String>, reqwest::Error> {
    let Some(url) = latest_release_api_url() else {
        return Ok(None);
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(concat!("ralph-tui/", env!("CARGO_PKG_VERSION"))),
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github+json"),
    );

    let client = reqwest::Client::builder()
        .default_headers(headers)
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()?;

    let response = client.get(url).send().await?;
    if release_missing(response.status()) {
        return Ok(None);
    }

    let release = response.error_for_status()?.json::<LatestRelease>().await?;

    Ok(release_tag(&release))
}

fn release_missing(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::NOT_FOUND
}

fn release_tag(release: &LatestRelease) -> Option<String> {
    if release.prerelease {
        return None;
    }
    normalize_version(&release.tag_name)
}

fn latest_release_api_url() -> Option<String> {
    let repository = env!("CARGO_PKG_REPOSITORY").trim_end_matches('/');
    let repo = repository
        .strip_prefix("https://github.com/")
        .or_else(|| repository.strip_prefix("http://github.com/"))
        .map(|value| value.trim_end_matches(".git"))
        .filter(|value| !value.is_empty())
        .unwrap_or("flaviomartil/ralph-jev-gauntlet");

    Some(format!(
        "https://api.github.com/repos/{repo}/releases/latest"
    ))
}

fn normalize_version(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_start_matches('v');
    let core = trimmed.split(['-', '+']).next()?.trim();
    if core.is_empty() || !core.split('.').all(|part| !part.is_empty()) {
        return None;
    }
    Some(core.to_string())
}

fn compare_versions(current: &str, latest: &str) -> Option<Ordering> {
    let current = parse_version(current)?;
    let latest = parse_version(latest)?;
    Some(current.cmp(&latest))
}

fn parse_version(version: &str) -> Option<Vec<u64>> {
    normalize_version(version)?
        .split('.')
        .map(|part| part.parse().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_release_tags() {
        assert_eq!(normalize_version("v2.8.0"), Some("2.8.0".to_string()));
        assert_eq!(normalize_version("2.8.0-beta.1"), Some("2.8.0".to_string()));
        assert_eq!(
            normalize_version("2.8.0+build.5"),
            Some("2.8.0".to_string())
        );
    }

    #[test]
    fn rejects_invalid_versions() {
        assert_eq!(normalize_version(""), None);
        assert_eq!(normalize_version("v"), None);
        assert_eq!(normalize_version("2..8"), None);
    }

    #[test]
    fn compares_versions_numerically() {
        assert_eq!(compare_versions("2.7.0", "2.8.0"), Some(Ordering::Less));
        assert_eq!(compare_versions("2.8.0", "2.8.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("2.10.0", "2.9.9"), Some(Ordering::Greater));
    }

    #[test]
    fn builds_github_release_api_url() {
        assert_eq!(
            latest_release_api_url(),
            Some(
                "https://api.github.com/repos/flaviomartil/ralph-jev-gauntlet/releases/latest"
                    .to_string()
            )
        );
    }

    #[test]
    fn treats_404_as_no_release() {
        assert!(release_missing(reqwest::StatusCode::NOT_FOUND));
        assert!(!release_missing(reqwest::StatusCode::OK));
    }

    #[test]
    fn skips_prerelease_tags() {
        let prerelease = LatestRelease {
            tag_name: "v9.9.9".to_string(),
            prerelease: true,
        };
        assert_eq!(release_tag(&prerelease), None);

        let stable = LatestRelease {
            tag_name: "v2.8.0".to_string(),
            prerelease: false,
        };
        assert_eq!(release_tag(&stable), Some("2.8.0".to_string()));
    }
}

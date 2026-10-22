//! Errors. Policy refusals carry every reason that fired, each with a stable
//! code, so the app (and the tests) can tell exactly which rule refused.

use mls_rs::error::MlsError;
use mls_rs_core::error::IntoAnyError;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Reason {
    pub code: &'static str,
    pub detail: String,
}

impl Reason {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Reason {
        Reason {
            code,
            detail: detail.into(),
        }
    }
}

/// Returned from the MlsRules and IdentityProvider callbacks; recovered from
/// the MlsError that wraps it.
#[derive(Clone, Debug)]
pub struct PolicyError {
    pub reasons: Vec<Reason>,
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let parts: Vec<String> = self
            .reasons
            .iter()
            .map(|r| format!("{}: {}", r.code, r.detail))
            .collect();
        write!(f, "{}", parts.join("; "))
    }
}

impl std::error::Error for PolicyError {}

impl IntoAnyError for PolicyError {
    fn into_dyn_error(self) -> Result<Box<dyn std::error::Error + Send + Sync>, Self> {
        Ok(Box::new(self))
    }
}

impl From<Reason> for PolicyError {
    fn from(reason: Reason) -> Self {
        PolicyError { reasons: vec![reason] }
    }
}

/// Errors from the storage and PSK callbacks (never policy).
#[derive(Debug)]
pub struct StoreError(pub String);

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StoreError {}

impl IntoAnyError for StoreError {
    fn into_dyn_error(self) -> Result<Box<dyn std::error::Error + Send + Sync>, Self> {
        Ok(Box::new(self))
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Error {
    /// `policy`, `mls`, `state` or `input`.
    pub kind: &'static str,
    pub message: String,
    pub reasons: Vec<Reason>,
}

impl Error {
    pub fn input(message: impl Into<String>) -> Error {
        Error {
            kind: "input",
            message: message.into(),
            reasons: Vec::new(),
        }
    }

    pub fn state(message: impl Into<String>) -> Error {
        Error {
            kind: "state",
            message: message.into(),
            reasons: Vec::new(),
        }
    }

    pub fn policy(reasons: Vec<Reason>) -> Error {
        let message = PolicyError {
            reasons: reasons.clone(),
        }
        .to_string();
        Error {
            kind: "policy",
            message,
            reasons,
        }
    }

    pub fn codec(e: mls_rs_codec::Error) -> Error {
        Error::state(format!("codec: {e:?}"))
    }

    /// Unwrap a policy refusal from inside a library error, wherever the
    /// library reports it.
    pub fn mls(e: MlsError) -> Error {
        let inner = match &e {
            MlsError::MlsRulesError(any) | MlsError::IdentityProviderError(any) => {
                any.inner_dyn_error().downcast_ref::<PolicyError>().cloned()
            }
            _ => None,
        };
        match inner {
            Some(policy) => Error::policy(policy.reasons),
            None => Error {
                kind: "mls",
                message: format!("{e:?}"),
                reasons: Vec::new(),
            },
        }
    }
}

impl From<MlsError> for Error {
    fn from(e: MlsError) -> Self {
        Error::mls(e)
    }
}

pub type Res<T> = std::result::Result<T, Error>;

use std::future::Future;
use std::time::Instant;

use serde_json::{json, Value};

#[derive(Default)]
pub struct ActionTimings(Option<Vec<Value>>);

impl ActionTimings {
    pub fn new(enabled: bool) -> Self {
        Self(enabled.then(|| Vec::with_capacity(12)))
    }

    pub async fn measure<T>(&mut self, phase: &'static str, future: impl Future<Output = T>) -> T {
        let Some(entries) = self.0.as_mut() else {
            return future.await;
        };
        let started = Instant::now();
        let result = future.await;
        if entries.len() < 24 {
            entries.push(json!({
                "phase": phase,
                "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64
            }));
        }
        result
    }

    pub fn finish(
        self,
        result: Result<Value, (String, String)>,
    ) -> Result<Value, (String, String)> {
        let Some(entries) = self.0 else {
            return result;
        };
        match result {
            Ok(mut value) => {
                if let Some(object) = value.as_object_mut() {
                    object.insert("timings".to_string(), Value::Array(entries));
                }
                Ok(value)
            }
            Err((code, message)) => Err((code, format!("{message}; timings={}", json!(entries)))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn disabled_diagnostics_leave_responses_unchanged() {
        let mut timings = ActionTimings::default();
        assert_eq!(timings.measure("input", async { 42 }).await, 42);
        assert!(timings.0.is_none());
        assert_eq!(
            timings.finish(Ok(json!({"ok": true}))).unwrap(),
            json!({"ok": true})
        );
    }

    #[tokio::test]
    async fn errors_retain_the_code_and_bounded_phase_evidence() {
        let mut timings = ActionTimings::new(true);
        for _ in 0..30 {
            let _: Result<(), ()> = timings.measure("mouseDown", async { Err(()) }).await;
        }
        assert_eq!(timings.0.as_ref().unwrap().len(), 24);
        let error = timings
            .finish(Err(("timeout".into(), "dispatch failed".into())))
            .unwrap_err();
        assert_eq!(error.0, "timeout");
        assert!(error.1.starts_with("dispatch failed; timings="));
        assert!(!error.1.contains("expectedValue"));
    }
}

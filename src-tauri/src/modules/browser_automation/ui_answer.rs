//! Answers the main window gives to Anbo's requests.
//!
//! Anbo asks the UI for work only it can do (the agent and terminal tools,
//! opening, closing and listing browser tabs, bringing a Chrome or Edge tab
//! forward before input) with an event that carries a request id. The UI
//! answers through the `ui_reply` command into this table, where the request
//! waits.
//!
//! The answers used to come back as events to a one-time Rust listener, and
//! some never arrived. Tauri 2.12's Rust listener table only tries its lock: a
//! listen or an emit that meets it is queued until an event next reaches a
//! listener, so a listener could miss its answer or an answer could stay
//! queued past the deadline. Each finished listener also left its event name
//! behind, which every later unlisten walked under that lock, so the losses
//! grew with the requests served. 64 agent_list calls at once lost 21 of 640
//! answers, and two at once lost one almost every time after a few thousand
//! requests (Oct 14 2026), while the UI had answered every one. An agent was
//! then told nothing had started, and a command it ran again ran twice.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use tokio::sync::oneshot;

static WAITING: LazyLock<Mutex<HashMap<String, oneshot::Sender<String>>>> =
    LazyLock::new(Default::default);
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

fn waiting() -> MutexGuard<'static, HashMap<String, oneshot::Sender<String>>> {
    WAITING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// An id no other request has, for a request whose answer nobody waits for.
pub fn request_id() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    )
}

/// The answer to one request, waited for from before the request goes out.
/// Dropping it stops the wait: a later answer is refused.
pub struct Answer {
    request_id: String,
    receiver: oneshot::Receiver<String>,
}

impl Answer {
    pub fn expect() -> Self {
        let request_id = request_id();
        let (sender, receiver) = oneshot::channel();
        waiting().insert(request_id.clone(), sender);
        Self {
            request_id,
            receiver,
        }
    }

    /// What the request carries, for the UI to answer to.
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// The answer as the UI's JSON, to await with a timeout.
    pub fn receiver(&mut self) -> &mut oneshot::Receiver<String> {
        &mut self.receiver
    }
}

impl Drop for Answer {
    fn drop(&mut self) {
        waiting().remove(&self.request_id);
    }
}

/// Hands the UI's answer to the request waiting for it, and says whether one
/// still was.
pub fn deliver(request_id: &str, answer: String) -> bool {
    let Some(sender) = waiting().remove(request_id) else {
        return false;
    };
    sender.send(answer).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc, Barrier};
    use std::thread;
    use tokio::sync::oneshot::error::TryRecvError;

    #[test]
    fn an_answer_reaches_its_request() {
        let mut answer = Answer::expect();
        assert!(deliver(answer.request_id(), "{\"ok\":true}".to_string()));
        assert_eq!(answer.receiver().try_recv().unwrap(), "{\"ok\":true}");
        assert!(!waiting().contains_key(answer.request_id()));
    }

    #[test]
    fn an_answer_after_the_wait_ended_is_refused() {
        let answer = Answer::expect();
        let id = answer.request_id().to_string();
        drop(answer);
        assert!(!waiting().contains_key(&id));
        assert!(!deliver(&id, "late".to_string()));
        assert!(!deliver("no-such-request", "stray".to_string()));
    }

    #[test]
    fn a_second_answer_to_one_request_is_refused() {
        let mut answer = Answer::expect();
        let id = answer.request_id().to_string();
        assert!(deliver(&id, "first".to_string()));
        assert!(!deliver(&id, "second".to_string()));
        assert_eq!(answer.receiver().try_recv().unwrap(), "first");
    }

    // The Tauri listener table lost answers exactly here: many requests
    // registering, answering and ending on several threads at once.
    #[test]
    fn concurrent_answers_all_arrive() {
        const THREADS: usize = 8;
        const PER_THREAD: usize = 250;
        let start = Arc::new(Barrier::new(THREADS * 2));
        let (ids, pending) = mpsc::channel::<String>();
        let pending = Arc::new(Mutex::new(pending));
        let askers: Vec<_> = (0..THREADS)
            .map(|_| {
                let start = start.clone();
                let ids = ids.clone();
                thread::spawn(move || {
                    let mut answers: Vec<_> = (0..PER_THREAD).map(|_| Answer::expect()).collect();
                    start.wait();
                    for answer in &answers {
                        ids.send(answer.request_id().to_string()).unwrap();
                    }
                    answers
                        .iter_mut()
                        .map(|answer| {
                            let id = answer.request_id().to_string();
                            let got = loop {
                                match answer.receiver().try_recv() {
                                    Ok(got) => break got,
                                    Err(TryRecvError::Empty) => thread::yield_now(),
                                    Err(TryRecvError::Closed) => panic!("{id} lost its answer"),
                                }
                            };
                            usize::from(got == id)
                        })
                        .sum::<usize>()
                })
            })
            .collect();
        drop(ids);
        let answerers: Vec<_> = (0..THREADS)
            .map(|_| {
                let start = start.clone();
                let pending = pending.clone();
                thread::spawn(move || {
                    start.wait();
                    let mut delivered = 0;
                    loop {
                        let next = pending.lock().unwrap().recv();
                        let Ok(id) = next else { break delivered };
                        delivered += usize::from(deliver(&id, id.clone()));
                    }
                })
            })
            .collect();
        let delivered: usize = answerers.into_iter().map(|t| t.join().unwrap()).sum();
        let received: usize = askers.into_iter().map(|t| t.join().unwrap()).sum();
        assert_eq!(delivered, THREADS * PER_THREAD);
        assert_eq!(received, THREADS * PER_THREAD);
    }

    #[test]
    fn request_ids_never_repeat() {
        let ids: std::collections::HashSet<_> = (0..1_000).map(|_| request_id()).collect();
        assert_eq!(ids.len(), 1_000);
    }
}

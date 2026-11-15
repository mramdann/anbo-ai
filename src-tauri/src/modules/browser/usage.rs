//! Which processes of Anbo's own browser serve which tab, for the usage view
//! (modules/usage.rs). WebView2 lists its processes with the frames each
//! renderer holds. A tab's main frame has the id its webview reports
//! (ICoreWebView2_20::FrameId), and a frame of another site inside it (an
//! iframe in a renderer of its own) climbs to that main frame through its
//! parents. Asked only while the usage view is open.

#[cfg(any(windows, test))]
use std::collections::HashMap;

/// What the usage view knows of Anbo's own browser.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserUsage {
    /// Each tab's renderer processes. A renderer a site's tabs share is listed
    /// under each of them.
    pub tabs: Vec<TabProcesses>,
    /// The browser's other processes: the browser itself, the GPU, utilities,
    /// and a renderer no tab holds (WebView2 keeps a spare one).
    pub engine: Vec<EngineProcess>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabProcesses {
    pub tab_id: i64,
    pub pids: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProcess {
    pub pid: u32,
    pub kind: &'static str,
}

/// A process as WebView2 lists it: its kind, and the main frame ids of the
/// frames it holds.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct Listed {
    pid: u32,
    kind: &'static str,
    main_frames: Vec<u32>,
}

/// The listed processes, by the tabs whose main frames they hold.
#[cfg(any(windows, test))]
fn assign(listed: &[Listed], main_frames: &[(i64, u32)]) -> BrowserUsage {
    let tab_of: HashMap<u32, i64> = main_frames
        .iter()
        .map(|(tab, frame)| (*frame, *tab))
        .collect();
    let mut tabs: HashMap<i64, Vec<u32>> = HashMap::new();
    let mut engine = Vec::new();
    for process in listed {
        let mut owners: Vec<i64> = process
            .main_frames
            .iter()
            .filter_map(|frame| tab_of.get(frame).copied())
            .collect();
        owners.sort_unstable();
        owners.dedup();
        if owners.is_empty() {
            engine.push(EngineProcess {
                pid: process.pid,
                kind: process.kind,
            });
            continue;
        }
        for tab in owners {
            tabs.entry(tab).or_default().push(process.pid);
        }
    }
    let mut tabs: Vec<TabProcesses> = tabs
        .into_iter()
        .map(|(tab_id, mut pids)| {
            pids.sort_unstable();
            pids.dedup();
            TabProcesses { tab_id, pids }
        })
        .collect();
    tabs.sort_by_key(|tab| tab.tab_id);
    engine.sort_by_key(|process| process.pid);
    BrowserUsage { tabs, engine }
}

#[cfg(windows)]
mod platform {
    use super::Listed;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use webview2_com::GetProcessExtendedInfosCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment13, ICoreWebView2FrameInfo, ICoreWebView2FrameInfo2,
        ICoreWebView2ProcessExtendedInfoCollection, ICoreWebView2_20, COREWEBVIEW2_PROCESS_KIND,
        COREWEBVIEW2_PROCESS_KIND_BROWSER, COREWEBVIEW2_PROCESS_KIND_GPU,
        COREWEBVIEW2_PROCESS_KIND_PPAPI_BROKER, COREWEBVIEW2_PROCESS_KIND_PPAPI_PLUGIN,
        COREWEBVIEW2_PROCESS_KIND_RENDERER, COREWEBVIEW2_PROCESS_KIND_SANDBOX_HELPER,
        COREWEBVIEW2_PROCESS_KIND_UTILITY,
    };
    use windows::core::{Interface, BOOL};

    /// How long one question to WebView2 may take before the view goes on
    /// without its answer.
    const ASK_TIMEOUT: Duration = Duration::from_millis(1500);
    /// Frames nested deeper than this are not climbed.
    const MAX_FRAME_DEPTH: usize = 32;

    type Reply<T> = Arc<Mutex<Option<tokio::sync::oneshot::Sender<T>>>>;

    fn send<T>(reply: &Reply<T>, value: T) {
        if let Some(sender) = reply.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = sender.send(value);
        }
    }

    fn kind_name(kind: COREWEBVIEW2_PROCESS_KIND) -> &'static str {
        match kind {
            COREWEBVIEW2_PROCESS_KIND_BROWSER => "browser",
            COREWEBVIEW2_PROCESS_KIND_RENDERER => "renderer",
            COREWEBVIEW2_PROCESS_KIND_UTILITY => "utility",
            COREWEBVIEW2_PROCESS_KIND_GPU => "gpu",
            COREWEBVIEW2_PROCESS_KIND_SANDBOX_HELPER => "sandboxHelper",
            COREWEBVIEW2_PROCESS_KIND_PPAPI_PLUGIN => "ppapiPlugin",
            COREWEBVIEW2_PROCESS_KIND_PPAPI_BROKER => "ppapiBroker",
            _ => "other",
        }
    }

    /// The id of the main frame `frame` belongs to.
    fn main_frame_of(frame: &ICoreWebView2FrameInfo) -> Option<u32> {
        let mut current: ICoreWebView2FrameInfo2 = frame.cast().ok()?;
        for _ in 0..MAX_FRAME_DEPTH {
            // A main frame has no parent: the call fails or gives nothing.
            match unsafe { current.ParentFrameInfo() }
                .ok()
                .and_then(|parent| parent.cast::<ICoreWebView2FrameInfo2>().ok())
            {
                Some(parent) => current = parent,
                None => break,
            }
        }
        let mut id = 0_u32;
        unsafe { current.FrameId(&mut id) }.ok()?;
        (id != 0).then_some(id)
    }

    fn listed(collection: &ICoreWebView2ProcessExtendedInfoCollection) -> Vec<Listed> {
        let mut out = Vec::new();
        let mut count = 0_u32;
        if unsafe { collection.Count(&mut count) }.is_err() {
            return out;
        }
        for index in 0..count {
            let Ok(info) = (unsafe { collection.GetValueAtIndex(index) }) else {
                continue;
            };
            let Ok(process) = (unsafe { info.ProcessInfo() }) else {
                continue;
            };
            let (mut pid, mut kind) = (0_i32, COREWEBVIEW2_PROCESS_KIND::default());
            if unsafe { process.ProcessId(&mut pid) }.is_err() || pid <= 0 {
                continue;
            }
            let _ = unsafe { process.Kind(&mut kind) };
            let mut main_frames = Vec::new();
            // The iterator reads its collection without holding it: the
            // collection stays alive until the last frame is read. Letting it
            // go as soon as the iterator came crashed Dev with an access
            // violation at the first frame (round 105).
            if let Ok(frames) = unsafe { info.AssociatedFrameInfos() } {
                if let Ok(iterator) = unsafe { frames.GetIterator() } {
                    let mut has = BOOL::default();
                    let _ = unsafe { iterator.HasCurrent(&mut has) };
                    while has.as_bool() {
                        if let Some(main) = unsafe { iterator.GetCurrent() }
                            .ok()
                            .and_then(|frame| main_frame_of(&frame))
                        {
                            main_frames.push(main);
                        }
                        if unsafe { iterator.MoveNext(&mut has) }.is_err() {
                            break;
                        }
                    }
                }
                drop(frames);
            }
            main_frames.sort_unstable();
            main_frames.dedup();
            out.push(Listed {
                pid: pid as u32,
                kind: kind_name(kind),
                main_frames,
            });
        }
        out
    }

    /// The id of the tab's main frame, as its webview reports it.
    pub(super) async fn main_frame_id(webview: &tauri::Webview) -> Option<u32> {
        let (sender, receiver) = tokio::sync::oneshot::channel::<Option<u32>>();
        let reply: Reply<Option<u32>> = Arc::new(Mutex::new(Some(sender)));
        let inner = reply.clone();
        let asked = webview.with_webview(move |platform| {
            let id = unsafe { platform.controller().CoreWebView2() }
                .ok()
                .and_then(|core| core.cast::<ICoreWebView2_20>().ok())
                .and_then(|core| {
                    let mut id = 0_u32;
                    unsafe { core.FrameId(&mut id) }.ok().map(|()| id)
                })
                .filter(|id| *id != 0);
            send(&inner, id);
        });
        if asked.is_err() {
            return None;
        }
        tokio::time::timeout(ASK_TIMEOUT, receiver)
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()
    }

    /// Every process of the browser `webview` belongs to, with its frames.
    pub(super) async fn list_processes(webview: &tauri::Webview) -> Option<Vec<Listed>> {
        let (sender, receiver) = tokio::sync::oneshot::channel::<Option<Vec<Listed>>>();
        let reply: Reply<Option<Vec<Listed>>> = Arc::new(Mutex::new(Some(sender)));
        let inner = reply.clone();
        let asked = webview.with_webview(move |platform| {
            let Ok(environment) = platform.environment().cast::<ICoreWebView2Environment13>()
            else {
                send(&inner, None);
                return;
            };
            let answer = inner.clone();
            let handler = GetProcessExtendedInfosCompletedHandler::create(Box::new(
                move |result, collection| {
                    let processes = match (result, collection) {
                        (Ok(()), Some(collection)) => Some(listed(&collection)),
                        _ => None,
                    };
                    send(&answer, processes);
                    Ok(())
                },
            ));
            if unsafe { environment.GetProcessExtendedInfos(&handler) }.is_err() {
                send(&inner, None);
            }
        });
        if asked.is_err() {
            return None;
        }
        tokio::time::timeout(ASK_TIMEOUT, receiver)
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()
    }
}

/// Which processes serve which open tab of Anbo's own browser, and which serve
/// no tab. Empty when no tab is open: the browser then runs no process, or
/// only the warm host's.
#[cfg(windows)]
pub(crate) async fn usage(app: &tauri::AppHandle) -> BrowserUsage {
    use tauri::Manager;
    let webviews: Vec<(i64, tauri::Webview)> = super::embed::list_active_tab_ids()
        .into_iter()
        .filter_map(|tab| {
            app.get_webview(&super::embed::embed_label(tab))
                .map(|webview| (tab, webview))
        })
        .collect();
    let Some((_, first)) = webviews.first().cloned() else {
        return BrowserUsage::default();
    };
    let mut main_frames = Vec::with_capacity(webviews.len());
    for (tab, webview) in &webviews {
        if let Some(frame) = platform::main_frame_id(webview).await {
            main_frames.push((*tab, frame));
        }
    }
    let listed = platform::list_processes(&first).await.unwrap_or_default();
    assign(&listed, &main_frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed(pid: u32, kind: &'static str, main_frames: &[u32]) -> Listed {
        Listed {
            pid,
            kind,
            main_frames: main_frames.to_vec(),
        }
    }

    #[test]
    fn a_renderer_belongs_to_the_tabs_whose_main_frames_it_holds() {
        let usage = assign(
            &[
                listed(10, "browser", &[]),
                listed(11, "gpu", &[]),
                // A page and an iframe of another site in its own renderer.
                listed(20, "renderer", &[101]),
                listed(21, "renderer", &[101]),
                // One site's two tabs share a renderer.
                listed(22, "renderer", &[102, 103]),
                // The spare renderer, and one for a page that just closed.
                listed(23, "renderer", &[]),
                listed(24, "renderer", &[999]),
            ],
            &[(7, 101), (8, 102), (9, 103)],
        );
        assert_eq!(
            usage.tabs,
            vec![
                TabProcesses {
                    tab_id: 7,
                    pids: vec![20, 21]
                },
                TabProcesses {
                    tab_id: 8,
                    pids: vec![22]
                },
                TabProcesses {
                    tab_id: 9,
                    pids: vec![22]
                },
            ]
        );
        assert_eq!(
            usage
                .engine
                .iter()
                .map(|p| (p.pid, p.kind))
                .collect::<Vec<_>>(),
            vec![
                (10, "browser"),
                (11, "gpu"),
                (23, "renderer"),
                (24, "renderer")
            ]
        );
    }

    #[test]
    fn no_tab_no_list() {
        assert_eq!(assign(&[], &[]), BrowserUsage::default());
        let usage = assign(&[listed(10, "browser", &[])], &[]);
        assert!(usage.tabs.is_empty());
        assert_eq!(usage.engine.len(), 1);
    }
}

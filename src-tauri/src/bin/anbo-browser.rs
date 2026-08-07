use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::exit;
#[cfg(windows)]
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceDescriptor {
    pub version: u32,
    pub pid: u32,
    pub pipe: String,
    pub token: String,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserRequest {
    pub version: u32,
    pub id: String,
    pub token: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserResponse {
    pub version: u32,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BrowserError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserError {
    pub code: String,
    pub message: String,
}

fn descriptor_path() -> Option<PathBuf> {
    let local_data = dirs::data_local_dir()?;
    let path = local_data
        .join("com.anboai.desktop")
        .join("runtime")
        .join("browser")
        .join("instance.json");
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn read_descriptor() -> Result<InstanceDescriptor, (i32, String)> {
    let path = descriptor_path().ok_or_else(|| {
        (
            3,
            "Anbo is not running or Browser Automation is disabled (instance.json not found)"
                .to_string(),
        )
    })?;
    let content = fs::read_to_string(&path).map_err(|e| {
        (
            3,
            format!("failed to read descriptor {}: {e}", path.display()),
        )
    })?;
    serde_json::from_str::<InstanceDescriptor>(&content)
        .map_err(|e| (3, format!("invalid descriptor format: {e}")))
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        print_usage();
        exit(2);
    }

    let subcommand = args[1].as_str();
    if matches!(subcommand, "help" | "--help" | "-h") {
        print_usage();
        return;
    }
    if matches!(subcommand, "version" | "--version" | "-V") {
        println!("anbo-browser {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if subcommand == "mcp" && args.get(2).map(|s| s.as_str()) == Some("--stdio") {
        run_mcp_stdio().await;
        return;
    }

    let is_json = args.iter().any(|a| a == "--json");
    let desc = match read_descriptor() {
        Ok(d) => d,
        Err((code, msg)) => {
            if is_json {
                println!(
                    "{}",
                    json!({ "ok": false, "error": { "code": "automation_disabled", "message": msg } })
                );
            } else {
                eprintln!("Error: {msg}");
            }
            exit(code);
        }
    };

    let (method, params) = match parse_cli_args(subcommand, &args[2..]) {
        Ok(res) => res,
        Err(msg) => {
            if is_json {
                println!(
                    "{}",
                    json!({ "ok": false, "error": { "code": "invalid_request", "message": msg } })
                );
            } else {
                eprintln!("Invalid arguments: {msg}");
            }
            exit(2);
        }
    };

    match execute_ipc_command(&desc, &method, params).await {
        Ok(res) => {
            if is_json {
                println!("{}", serde_json::to_string(&res).unwrap());
            } else if res.get("snapshot").is_some() {
                println!("{}", res.get("snapshot").unwrap().as_str().unwrap_or(""));
            } else {
                println!("{}", serde_json::to_string_pretty(&res).unwrap());
            }
            exit(0);
        }
        Err((code, err_msg)) => {
            if is_json {
                println!(
                    "{}",
                    json!({ "ok": false, "error": { "code": "command_failed", "message": err_msg } })
                );
            } else {
                eprintln!("Command failed: {err_msg}");
            }
            exit(code);
        }
    }
}

fn print_usage() {
    eprintln!("Usage: anbo-browser <command> [options] [--json]");
    eprintln!("Commands:");
    eprintln!("  tabs                                  List active browser tabs");
    eprintln!("  get-url --tab <id>                    Get tab's current URL");
    eprintln!("  navigate --tab <id> --url <url>       Navigate tab to URL");
    eprintln!("  reload --tab <id>                     Reload tab");
    eprintln!("  back --tab <id>                       Navigate back");
    eprintln!("  forward --tab <id>                    Navigate forward");
    eprintln!("  stop --tab <id>                       Stop page load");
    eprintln!("  snapshot --tab <id>                   Get text snapshot with stable element refs");
    eprintln!("  click --tab <id> --ref <ref>          Click element by ref (e.g. e12)");
    eprintln!("  type --tab <id> --ref <ref> --text \"msg\" [--append]");
    eprintln!("  press --tab <id> --key <key>          Press keyboard key");
    eprintln!("  scroll --tab <id> [--x 0] [--y 600]   Scroll page");
    eprintln!("  wait --tab <id> --text \"msg\" [--timeout 10000]");
    eprintln!("  screenshot --tab <id>                 Capture screenshot to disk artifact");
    eprintln!("  mcp --stdio                           Run Model Context Protocol stdio server");
}

fn parse_cli_args(subcommand: &str, args: &[String]) -> Result<(String, Value), String> {
    let mut tab_id = None;
    let mut url = None;
    let mut ref_id = None;
    let mut text = None;
    let mut key = None;
    let mut append = false;
    let mut x = 0.0;
    let mut y = 0.0;
    let mut timeout = 10000u64;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--tab" => {
                i += 1;
                tab_id = Some(
                    args.get(i)
                        .ok_or("missing value for --tab")?
                        .parse::<i64>()
                        .map_err(|_| "invalid tab id")?,
                );
            }
            "--url" => {
                i += 1;
                url = Some(args.get(i).ok_or("missing value for --url")?.clone());
            }
            "--ref" => {
                i += 1;
                ref_id = Some(args.get(i).ok_or("missing value for --ref")?.clone());
            }
            "--text" => {
                i += 1;
                text = Some(args.get(i).ok_or("missing value for --text")?.clone());
            }
            "--key" => {
                i += 1;
                key = Some(args.get(i).ok_or("missing value for --key")?.clone());
            }
            "--append" => {
                append = true;
            }
            "--x" => {
                i += 1;
                x = args
                    .get(i)
                    .ok_or("missing value for --x")?
                    .parse::<f64>()
                    .map_err(|_| "invalid x")?;
            }
            "--y" => {
                i += 1;
                y = args
                    .get(i)
                    .ok_or("missing value for --y")?
                    .parse::<f64>()
                    .map_err(|_| "invalid y")?;
            }
            "--timeout" => {
                i += 1;
                timeout = args
                    .get(i)
                    .ok_or("missing value for --timeout")?
                    .parse::<u64>()
                    .map_err(|_| "invalid timeout")?;
            }
            "--json" => {}
            other => return Err(format!("unknown option '{other}'")),
        }
        i += 1;
    }

    match subcommand {
        "tabs" | "list_tabs" | "list-tabs" => Ok(("list_tabs".to_string(), json!({}))),
        "get-url" => Ok((
            "get_url".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")? }),
        )),
        "navigate" => Ok((
            "navigate".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")?, "url": url.ok_or("missing --url")? }),
        )),
        "reload" => Ok((
            "reload".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")? }),
        )),
        "back" => Ok((
            "back".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")? }),
        )),
        "forward" => Ok((
            "forward".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")? }),
        )),
        "stop" => Ok((
            "stop".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")? }),
        )),
        "snapshot" => Ok((
            "snapshot".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")? }),
        )),
        "click" => Ok((
            "click".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")?, "ref": ref_id.ok_or("missing --ref")? }),
        )),
        "type" => Ok((
            "type_text".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")?, "ref": ref_id.ok_or("missing --ref")?, "text": text.ok_or("missing --text")?, "append": append }),
        )),
        "press" => Ok((
            "press_key".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")?, "key": key.ok_or("missing --key")? }),
        )),
        "scroll" => Ok((
            "scroll".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")?, "x": x, "y": y }),
        )),
        "wait" => Ok((
            "wait".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")?, "text": text.ok_or("missing --text")?, "timeout": timeout }),
        )),
        "screenshot" => Ok((
            "screenshot".to_string(),
            json!({ "tabId": tab_id.ok_or("missing --tab")? }),
        )),
        other => Err(format!("unknown command '{other}'")),
    }
}

async fn execute_ipc_command(
    desc: &InstanceDescriptor,
    method: &str,
    params: Value,
) -> Result<Value, (i32, String)> {
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;

        let client = ClientOptions::new().open(&desc.pipe).map_err(|e| {
            (
                3,
                format!("failed to connect to named pipe {}: {e}", desc.pipe),
            )
        })?;

        let (reader, mut writer) = tokio::io::split(client);
        let mut buf_reader = BufReader::new(reader);

        let req = BrowserRequest {
            version: 1,
            id: format!(
                "cli-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ),
            token: desc.token.clone(),
            method: method.to_string(),
            params,
        };

        let mut req_bytes = serde_json::to_vec(&req).map_err(|e| (4, e.to_string()))?;
        req_bytes.push(b'\n');

        writer
            .write_all(&req_bytes)
            .await
            .map_err(|e| (4, format!("pipe write error: {e}")))?;
        writer
            .flush()
            .await
            .map_err(|e| (4, format!("pipe flush error: {e}")))?;

        let mut line = String::new();
        buf_reader
            .read_line(&mut line)
            .await
            .map_err(|e| (4, format!("pipe read error: {e}")))?;

        let resp: BrowserResponse =
            serde_json::from_str(&line).map_err(|e| (4, format!("invalid response JSON: {e}")))?;

        if resp.ok {
            Ok(resp.result.unwrap_or(json!({})))
        } else {
            let err_msg = resp
                .error
                .map(|e| format!("[{}] {}", e.code, e.message))
                .unwrap_or_else(|| "unknown error".to_string());
            Err((4, err_msg))
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (desc, method, params);
        Err((
            3,
            "browser automation is only supported on Windows".to_string(),
        ))
    }
}

async fn run_mcp_stdio() {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();

    while let Ok(n) = reader.read_line(&mut line).await {
        if n == 0 {
            break;
        }
        let input_line = line.clone();
        line.clear();

        let Ok(req) = serde_json::from_str::<Value>(&input_line) else {
            continue;
        };

        let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let id = req.get("id").cloned();

        match method {
            "initialize" => {
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {
                            "tools": {}
                        },
                        "serverInfo": {
                            "name": "anbo-browser",
                            "version": env!("CARGO_PKG_VERSION")
                        }
                    }
                });
                let _ = stdout
                    .write_all(format!("{}\n", serde_json::to_string(&resp).unwrap()).as_bytes())
                    .await;
                let _ = stdout.flush().await;
            }
            "tools/list" => {
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "tools": [
                            { "name": "browser_tabs", "description": "List active native browser tabs in Anbo", "inputSchema": { "type": "object", "properties": {} } },
                            { "name": "browser_get_url", "description": "Get current URL of a browser tab", "inputSchema": { "type": "object", "properties": { "tabId": { "type": "integer" } }, "required": ["tabId"] } },
                            { "name": "browser_navigate", "description": "Navigate a browser tab to an HTTP/HTTPS URL", "inputSchema": { "type": "object", "properties": { "tabId": { "type": "integer" }, "url": { "type": "string" } }, "required": ["tabId", "url"] } },
                            { "name": "browser_snapshot", "description": "Get accessibility text snapshot with stable element refs (e1, e2, ...)", "inputSchema": { "type": "object", "properties": { "tabId": { "type": "integer" } }, "required": ["tabId"] } },
                            { "name": "browser_click", "description": "Click an element by ref (e1, e2, ...)", "inputSchema": { "type": "object", "properties": { "tabId": { "type": "integer" }, "ref": { "type": "string" } }, "required": ["tabId", "ref"] } },
                            { "name": "browser_type", "description": "Type text into an input element by ref", "inputSchema": { "type": "object", "properties": { "tabId": { "type": "integer" }, "ref": { "type": "string" }, "text": { "type": "string" }, "append": { "type": "boolean" } }, "required": ["tabId", "ref", "text"] } },
                            { "name": "browser_press", "description": "Press a keyboard key (e.g. Enter, Tab)", "inputSchema": { "type": "object", "properties": { "tabId": { "type": "integer" }, "key": { "type": "string" } }, "required": ["tabId", "key"] } },
                            { "name": "browser_scroll", "description": "Scroll the page", "inputSchema": { "type": "object", "properties": { "tabId": { "type": "integer" }, "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["tabId"] } },
                            { "name": "browser_wait", "description": "Wait for text content to appear on the page", "inputSchema": { "type": "object", "properties": { "tabId": { "type": "integer" }, "text": { "type": "string" }, "timeout": { "type": "integer" } }, "required": ["tabId", "text"] } },
                            { "name": "browser_screenshot", "description": "Capture screenshot of browser tab to disk artifact", "inputSchema": { "type": "object", "properties": { "tabId": { "type": "integer" } }, "required": ["tabId"] } }
                        ]
                    }
                });
                let _ = stdout
                    .write_all(format!("{}\n", serde_json::to_string(&resp).unwrap()).as_bytes())
                    .await;
                let _ = stdout.flush().await;
            }
            "tools/call" => {
                let params_obj = req.get("params").cloned().unwrap_or(json!({}));
                let name = params_obj
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let tool_args = params_obj.get("arguments").cloned().unwrap_or(json!({}));

                let mapped_method = match name {
                    "browser_tabs" => "list_tabs",
                    "browser_get_url" => "get_url",
                    "browser_navigate" => "navigate",
                    "browser_snapshot" => "snapshot",
                    "browser_click" => "click",
                    "browser_type" => "type_text",
                    "browser_press" => "press_key",
                    "browser_scroll" => "scroll",
                    "browser_wait" => "wait",
                    "browser_screenshot" => "screenshot",
                    _ => "",
                };

                if mapped_method.is_empty() {
                    let resp = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } });
                    let _ = stdout
                        .write_all(
                            format!("{}\n", serde_json::to_string(&resp).unwrap()).as_bytes(),
                        )
                        .await;
                    let _ = stdout.flush().await;
                    continue;
                }

                let desc_res = read_descriptor();
                let result_val = match desc_res {
                    Ok(desc) => match execute_ipc_command(&desc, mapped_method, tool_args).await {
                        Ok(val) => {
                            json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&val).unwrap() }] })
                        }
                        Err((_, err_msg)) => {
                            json!({ "isError": true, "content": [{ "type": "text", "text": format!("Error: {err_msg}") }] })
                        }
                    },
                    Err((_, err_msg)) => {
                        json!({ "isError": true, "content": [{ "type": "text", "text": format!("Automation disabled: {err_msg}") }] })
                    }
                };

                let resp = json!({ "jsonrpc": "2.0", "id": id, "result": result_val });
                let _ = stdout
                    .write_all(format!("{}\n", serde_json::to_string(&resp).unwrap()).as_bytes())
                    .await;
                let _ = stdout.flush().await;
            }
            _ => {
                if id.is_some() {
                    let resp = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } });
                    let _ = stdout
                        .write_all(
                            format!("{}\n", serde_json::to_string(&resp).unwrap()).as_bytes(),
                        )
                        .await;
                    let _ = stdout.flush().await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_cli_args_tab_list_aliases() {
        for command in ["tabs", "list_tabs", "list-tabs"] {
            let (method, _) = parse_cli_args(command, &[]).unwrap();
            assert_eq!(method, "list_tabs");
        }
    }

    #[test]
    fn test_parse_cli_args_click() {
        let args = vec![
            "--tab".to_string(),
            "1".to_string(),
            "--ref".to_string(),
            "e12".to_string(),
        ];
        let (method, params) = parse_cli_args("click", &args).unwrap();
        assert_eq!(method, "click");
        assert_eq!(params.get("tabId").unwrap().as_i64(), Some(1));
        assert_eq!(params.get("ref").unwrap().as_str(), Some("e12"));
    }
}

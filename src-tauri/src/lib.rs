use axum::{
    Router,
    body::Body,
    extract::{Query, State},
    http::{Response, StatusCode, header},
    response::IntoResponse,
};
use reqwest::Client;
use serde::Deserialize;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::RwLock;

/// Shared state for the proxy server and Tauri commands.
struct AppState {
    /// HTTP client for proxying
    client: Client,
    /// The port the proxy is listening on
    proxy_port: RwLock<u16>,
}

/// Tauri command: fetch a URL from the Rust backend (for M3U playlist loading).
#[tauri::command]
async fn fetch_url(
    state: tauri::State<'_, Arc<AppState>>,
    url: String,
) -> Result<String, String> {
    let response = state
        .client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch: {} {}",
            response.status().as_u16(),
            response.status().canonical_reason().unwrap_or("Unknown")
        ));
    }

    response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))
}

/// Tauri command: return the proxy port.
#[tauri::command]
async fn get_proxy_port(state: tauri::State<'_, Arc<AppState>>) -> Result<u16, String> {
    let port = state.proxy_port.read().await;
    Ok(*port)
}

/// Tauri command: read config.json from the app data directory.
#[tauri::command]
async fn read_config(app_handle: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    let config_path = data_dir.join("config.json");

    if !config_path.exists() {
        return Ok(String::from("{}"));
    }

    std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))
}

/// Tauri command: write config.json to the app data directory.
#[tauri::command]
async fn write_config(app_handle: tauri::AppHandle, data: String) -> Result<(), String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;

    let config_path = data_dir.join("config.json");

    std::fs::write(&config_path, data)
        .map_err(|e| format!("Failed to write config: {}", e))
}

/// Query params for the proxy endpoint.
#[derive(Deserialize)]
struct ProxyQuery {
    url: String,
}

/// Resolve a potentially relative URL against a base manifest URL.
fn resolve_url(base: &url::Url, raw: &str) -> String {
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return raw.to_string();
    }
    match base.join(raw) {
        Ok(resolved) => resolved.to_string(),
        Err(_) => raw.to_string(),
    }
}

/// Rewrite an m3u8 manifest so every URL line goes through the proxy.
fn rewrite_manifest(content: &str, manifest_url: &str, proxy_port: u16) -> String {
    let base = match url::Url::parse(manifest_url) {
        Ok(u) => u,
        Err(_) => return content.to_string(),
    };

    content
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                // Rewrite URI= attributes inside #EXT tags (e.g. #EXT-X-MAP:URI="init.mp4")
                if trimmed.contains("URI=\"") {
                    let mut result = line.to_string();
                    if let Some(start) = result.find("URI=\"") {
                        let uri_start = start + 5;
                        if let Some(end) = result[uri_start..].find('"') {
                            let uri = &result[uri_start..uri_start + end].to_string();
                            let abs = resolve_url(&base, uri);
                            let proxy = format!(
                                "http://127.0.0.1:{}/proxy?url={}",
                                proxy_port,
                                urlencoding::encode(&abs)
                            );
                            result = format!(
                                "{}URI=\"{}\"{}",
                                &line[..start],
                                proxy,
                                &line[uri_start + end + 1..]
                            );
                        }
                    }
                    result
                } else {
                    line.to_string()
                }
            } else {
                // This is a URL line — resolve it and wrap in proxy
                let abs = resolve_url(&base, trimmed);
                format!(
                    "http://127.0.0.1:{}/proxy?url={}",
                    proxy_port,
                    urlencoding::encode(&abs)
                )
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Axum handler: proxy requests with the target URL passed as a query param.
/// Streams the response body for live TS streams; buffers only for manifest rewriting.
async fn proxy_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ProxyQuery>,
) -> impl IntoResponse {
    let target_url = &params.url;
    let proxy_port = *state.proxy_port.read().await;

    let is_manifest = target_url.ends_with(".m3u8")
        || target_url.contains(".m3u8?")
        || target_url.ends_with(".m3u");

    match state.client.get(target_url).send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);

            // Use the final URL after any redirects for resolving relative paths
            let final_url = resp.url().to_string();

            let content_type = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();

            let ct_lower = content_type.to_lowercase();
            let needs_rewrite = is_manifest
                || ct_lower.contains("mpegurl")
                || ct_lower.contains("m3u");

            if needs_rewrite {
                // Buffer manifest content for URL rewriting
                let body_bytes = match resp.bytes().await {
                    Ok(b) => b,
                    Err(e) => {
                        return Response::builder()
                            .status(StatusCode::BAD_GATEWAY)
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .body(Body::from(format!("Failed to read response: {}", e)))
                            .unwrap();
                    }
                };

                let text = String::from_utf8_lossy(&body_bytes);
                let rewritten = rewrite_manifest(&text, &final_url, proxy_port);

                Response::builder()
                    .status(status)
                    .header(header::CONTENT_TYPE, &content_type)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, OPTIONS")
                    .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
                    .body(Body::from(rewritten))
                    .unwrap()
            } else {
                // Stream the response body directly (essential for live TS streams)
                let stream = resp.bytes_stream();
                let body = Body::from_stream(stream);

                Response::builder()
                    .status(status)
                    .header(header::CONTENT_TYPE, &content_type)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, OPTIONS")
                    .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
                    .body(body)
                    .unwrap()
            }
        }
        Err(e) => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::from(format!("Proxy error: {}", e)))
            .unwrap(),
    }
}

/// Start the local HTTP proxy server on a random port.
async fn start_proxy_server(state: Arc<AppState>) -> u16 {
    let app = Router::new()
        .route("/proxy", axum::routing::get(proxy_handler))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("Failed to bind proxy server");

    let port = listener.local_addr().unwrap().port();
    println!("Stream proxy started on http://127.0.0.1:{}", port);

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    port
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(AppState {
        client: Client::new(),
        proxy_port: RwLock::new(0),
    });

    let state_clone = state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state.clone())
        .setup(move |app| {
            // Set window icon (visible in Linux dock during dev mode)
            if let Some(window) = app.get_webview_window("main") {
                let png_data = include_bytes!("../icons/128x128.png");
                let decoder = png::Decoder::new(png_data.as_slice());
                if let Ok(mut reader) = decoder.read_info() {
                    let mut buf = vec![0u8; reader.output_buffer_size()];
                    if let Ok(info) = reader.next_frame(&mut buf) {
                        buf.truncate(info.buffer_size());
                        let icon = tauri::image::Image::new_owned(buf, info.width, info.height);
                        let _ = window.set_icon(icon);
                    }
                }
            }

            let state = state_clone.clone();
            tauri::async_runtime::spawn(async move {
                let port = start_proxy_server(state.clone()).await;
                let mut proxy_port = state.proxy_port.write().await;
                *proxy_port = port;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fetch_url,
            get_proxy_port,
            read_config,
            write_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

//! Rotas HTTP. Contrato congelado C5 + rotas aditivas do PLAN-REFACTOR §71.

pub mod bridge_config;
pub mod chat_sse;
pub mod health;
pub mod probe;
pub mod proposals;
pub mod providers;
pub mod sessions;
pub mod settings;
pub mod spotify_auth;
pub mod storage;

use axum::routing::{delete, get, post, put};
use axum::Router;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::AppState;

/// Monta o router completo.
pub fn router(state: AppState) -> Router {
    let cors = if state.bridge.is_headless() {
        // Uma UI web headless deve usar um proxy da mesma origem. O daemon
        // inclui segredos e controle da conta; não libera CORS para sites.
        CorsLayer::new()
    } else {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any)
    };

    Router::new()
        // C5 — congeladas
        .route("/config", get(bridge_config::config))
        .route("/health", get(health::health))
        .route("/sessions", get(sessions::list))
        .route("/sessions/:id", get(sessions::read))
        .route(
            "/history/:id",
            get(sessions::history).delete(sessions::erase),
        )
        .route("/probe", get(probe::probe))
        .route("/ws", get(crate::ws::ws_handler))
        // Aditivas
        .route("/chat", post(chat_sse::chat))
        .route("/chat/:id/cancel", post(chat_sse::cancel))
        .route("/proposals", get(proposals::list))
        .route("/proposals/:id", post(proposals::decide))
        .route(
            "/spotify/auth",
            get(spotify_auth::status).delete(spotify_auth::cancel),
        )
        .route("/spotify/auth/start", post(spotify_auth::start))
        .route("/providers", get(providers::list).post(providers::upsert))
        .route("/providers/:id", delete(providers::remove))
        .route("/providers/test", post(providers::test))
        .route("/models", get(providers::models))
        .route(
            "/settings",
            get(settings::get_settings).put(settings::put_settings),
        )
        // Perfil de modelo: teste de conexão com latência medida.
        .route("/profiles/:id/test", post(settings::test_profile))
        // Armazenamento (página "Armazenamento"): inspeção e limpeza explícita.
        .route("/storage", get(storage::get))
        .route("/storage/erase", post(storage::erase))
        // MCP (Streamable HTTP): initialize / tools/list / tools/call / resources
        .route(
            "/mcp",
            get(crate::mcp::http::get).post(crate::mcp::http::post),
        )
        .route("/mcp", delete(crate::mcp::http::delete))
        // Placeholder para quem chamar PUT no /mcp por engano.
        .route("/mcp/:verb", put(crate::mcp::http::method_not_allowed))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            proposals::headless_auth,
        ))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

//! Catálogo MCP: resources e prompts (além das tools, que vêm de
//! `tools::catalog` — D5: um só catálogo).

use serde_json::{json, Value};

/// Resources expostos em `resources/list`.
pub fn resources() -> Vec<Value> {
    vec![
        json!({
            "uri": "euterpe://playlists",
            "name": "Playlists",
            "description": "As playlists do usuário (via get_playlists no cliente Spotify)",
            "mimeType": "application/json",
        }),
        json!({
            "uri": "euterpe://currently-playing",
            "name": "Currently playing",
            "description": "O que está tocando agora no cliente Spotify",
            "mimeType": "application/json",
        }),
        json!({
            "uri": "euterpe://voice",
            "name": "Brand voice & tone",
            "description": "Diretrizes de tom de voz, identidade e estilo do assistente musical Euterpe",
            "mimeType": "application/json",
        }),
    ]
}

/// Tool a executar para materializar um resource.
pub fn resource_tool(uri: &str) -> Option<(&'static str, Value)> {
    match uri {
        "euterpe://playlists" => Some(("get_playlists", json!({}))),
        "euterpe://currently-playing" => Some(("get_currently_playing", json!({}))),
        _ => None,
    }
}

/// Prompts expostos em `prompts/list`.
pub fn prompts() -> Vec<Value> {
    vec![json!({
        "name": "curate-playlist",
        "title": "Curar uma playlist",
        "description": "Monte uma playlist a partir de um tema, humor ou artista, com justificativa por faixa.",
        "arguments": [
            { "name": "brief", "description": "O tema/humor/artista desejado", "required": true },
            { "name": "size", "description": "Quantidade aproximada de faixas", "required": false },
        ],
    })]
}

/// Conteúdo do prompt (messages no formato MCP).
pub fn prompt_messages(name: &str, args: &Value) -> Option<Vec<Value>> {
    if name != "curate-playlist" {
        return None;
    }
    let brief = args.get("brief").and_then(|v| v.as_str()).unwrap_or("");
    let size = args.get("size").and_then(|v| v.as_i64()).unwrap_or(20);
    let text = format!(
        "Monte uma playlist de aproximadamente {size} faixas para: {brief}.\n\
         1. Leia as playlists, faixas salvas e artistas principais do usuário (get_playlists, get_saved_tracks, get_top_artists).\n\
         2. Use search_spotify/get_recommendations para achar candidatos e enrich_tracks para cruzar gênero/features.\n\
         3. Apresente a proposta com justificativa por faixa (template {{{{spotify:track:URI|Nome}}}}).\n\
         4. Só então chame create_playlist — a criação é confirmada pelo usuário."
    );
    Some(vec![json!({
        "role": "user",
        "content": { "type": "text", "text": text },
    })])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resources_are_stable() {
        let uris: Vec<String> = resources()
            .iter()
            .map(|r| r["uri"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            uris,
            vec![
                "euterpe://playlists",
                "euterpe://currently-playing",
                "euterpe://voice"
            ]
        );
    }

    #[test]
    fn each_resource_maps_to_a_real_tool() {
        for r in resources() {
            let uri = r["uri"].as_str().unwrap();
            if uri == "euterpe://voice" {
                continue;
            }
            let (tool, _) = resource_tool(uri).unwrap_or_else(|| panic!("resource {uri} sem tool"));
            assert!(
                crate::tools::catalog::find(tool).is_some(),
                "tool {tool} fora do catálogo"
            );
        }
    }

    #[test]
    fn unknown_resource_is_none() {
        assert!(resource_tool("euterpe://nao-existe").is_none());
    }

    #[test]
    fn curate_prompt_requires_brief() {
        let messages =
            prompt_messages("curate-playlist", &json!({"brief":"chuva","size":10})).unwrap();
        let text = messages[0]["content"]["text"].as_str().unwrap();
        assert!(text.contains("chuva"));
        assert!(text.contains("10 faixas"));
        assert!(prompt_messages("other", &json!({})).is_none());
    }
}

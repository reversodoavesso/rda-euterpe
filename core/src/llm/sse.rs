//! Parser SSE único (tolerante a chunk cortando no meio de um `data:`).
//!
//! Regras do evento SSE:
//!  - linhas em branco separam eventos;
//!  - `data:` pode repetir (várias linhas viram uma só, com `\n`);
//!  - linhas com `:` inicial são comentários (heartbeats `: keep-alive`);
//!  - `event:` define o tipo; aceitamos `\n` e `\r\n`.

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
    /// `id:` do stream (Gemini/Anthropic usam para retomar).
    pub id: Option<String>,
}

impl SseEvent {
    /// Convenção do OpenAI/SSE: `[DONE]` encerra o stream.
    pub fn is_done(&self) -> bool {
        self.data.trim() == "[DONE]"
    }
}

#[derive(Debug, Default)]
pub struct SseDecoder {
    buffer: String,
    event: Option<String>,
    id: Option<String>,
    data: Vec<String>,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Alimenta o decoder com um pedaço de texto e devolve os eventos completos.
    pub fn push(&mut self, chunk: &str) -> Vec<SseEvent> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();
        while let Some(pos) = self.buffer.find('\n') {
            let line = self.buffer[..pos].trim_end_matches('\r').to_string();
            self.buffer = self.buffer[pos + 1..].to_string();
            self.consume_line(&line, &mut events);
        }
        events
    }

    /// Sinaliza fim do stream: processa o resto do buffer (sem `\n` final).
    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        if !self.buffer.is_empty() {
            let pending = std::mem::take(&mut self.buffer);
            let pending = pending.trim_end_matches('\r');
            self.consume_line(pending, &mut events);
        }
        self.dispatch(&mut events);
        events
    }

    fn consume_line(&mut self, line: &str, events: &mut Vec<SseEvent>) {
        if line.is_empty() {
            self.dispatch(events);
            return;
        }
        if line.starts_with(':') {
            return; // comentário / heartbeat
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            "id" => self.id = Some(value.to_string()),
            _ => {} // `retry:` e campos desconhecidos: ignorados
        }
    }

    fn dispatch(&mut self, events: &mut Vec<SseEvent>) {
        if self.data.is_empty() && self.event.is_none() {
            return;
        }
        events.push(SseEvent {
            event: self.event.take(),
            data: self.data.join("\n"),
            id: self.id.take(),
        });
        self.data.clear();
    }

    /// Extrai o JSON do evento (tolerante: ignora eventos não-JSON).
    pub fn json_of(event: &SseEvent) -> Option<serde_json::Value> {
        let raw = event.data.trim();
        if raw.is_empty() {
            return None;
        }
        serde_json::from_str(raw).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_events() {
        let mut d = SseDecoder::new();
        let evs = d.push("data: {\"a\":1}\n\ndata: [DONE]\n\n");
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].data, "{\"a\":1}");
        assert!(evs[1].is_done());
    }

    #[test]
    fn tolerates_chunks_cutting_a_data_line() {
        let mut d = SseDecoder::new();
        assert!(d.push("da").is_empty());
        assert!(d.push("ta: {\"hel").is_empty());
        let evs = d.push("lo\": \"wor");
        assert!(evs.is_empty());
        let evs = d.push("ld\"}\n\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "{\"hello\": \"world\"}");
    }

    #[test]
    fn handles_crlf_and_comments_and_named_events() {
        let mut d = SseDecoder::new();
        let evs = d.push(": keep-alive\r\nevent: message\r\ndata: {}\r\n\r\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].event.as_deref(), Some("message"));
        assert_eq!(evs[0].data, "{}");
    }

    #[test]
    fn multiline_data_is_joined_with_newline() {
        let mut d = SseDecoder::new();
        let evs = d.push("data: line1\ndata: line2\n\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "line1\nline2");
    }

    #[test]
    fn finish_flushes_a_trailing_event_without_blank_line() {
        let mut d = SseDecoder::new();
        assert!(d.push("data: [DONE]").is_empty());
        let evs = d.finish();
        assert_eq!(evs.len(), 1);
        assert!(evs[0].is_done());
    }

    #[test]
    fn json_of_is_tolerant() {
        let ev = SseEvent {
            data: "[DONE]".into(),
            ..Default::default()
        };
        assert!(SseDecoder::json_of(&ev).is_none());
        let ev = SseEvent {
            data: "{\"x\":1}".into(),
            ..Default::default()
        };
        assert_eq!(SseDecoder::json_of(&ev).unwrap()["x"], 1);
    }
}

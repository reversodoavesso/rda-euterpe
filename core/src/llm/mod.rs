//! Camada LLM: canônico, SSE, prompts, loop agentic, sugestões e adapters.

pub mod adapters;
pub mod canonical;
pub mod r#loop;
pub mod prompts;
pub mod sse;
pub mod suggestions;

pub use canonical::{
    Caps, ChatRequest, Completion, LlmAdapter, LlmEvent, ModelInfo, Msg, TestReport, ToolCall,
};
pub use r#loop::{handle_chat, handle_song_change, run_agent_loop, ChatDeps, LoopOutcome};

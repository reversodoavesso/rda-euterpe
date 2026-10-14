//! Composition root: sem lógica de negócio, só o encanamento de boot.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Qualquer erro de boot ainda é visto pelo usuário (stderr) mesmo antes do
    // subscriber de `tracing` subir.
    if let Err(err) = euterpe::cli::run().await {
        eprintln!("euterpe: {}", err);
        std::process::exit(1);
    }
    Ok(())
}

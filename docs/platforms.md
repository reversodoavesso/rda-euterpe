# Instalação e autostart por plataforma

O Euterpe tem um daemon Rust por usuário e uma extensão Spicetify que conecta por
HTTP/WebSocket em `127.0.0.1:8337`. O daemon inicia no logon, mesmo se o Spotify
estiver fechado. Isso também permite o uso do MCP externo. Ele não precisa de
Node/Electron no renderer, nem de monitorar a lista de processos do Spotify.

## Compilar e instalar

Requisitos: Spotify desktop compatível com Spicetify, Spicetify aplicado, Node
20+ para instalar/construir a interface, Rust conforme `core/rust-toolchain.toml`
e um compilador C (SQLite é compilado junto). Node não é necessário no runtime.

- Windows: MSVC Build Tools ou a toolchain GNU/WinLibs descrita em `core/README.md`.
- Linux: compilador C, pkg-config e headers OpenSSL (Debian/Ubuntu:
  `sudo apt install build-essential pkg-config libssl-dev`).
- macOS: Xcode Command Line Tools (`xcode-select --install`). Intel e Apple Silicon
  usam seu alvo nativo. O daemon usa os serviços de TLS do sistema.

Na raiz do repositório, em cada plataforma:

```text
cd core
cargo build --release
cd ..
npm ci --prefix app
node app/install.mjs
```

Compile dentro de `core/` para que o Cargo leia a toolchain fixada e `.cargo/config.toml`.
O binário padrão fica em `core/target/release/euterpe[.exe]`. Builds com `--target`
ficam em `core/target/<triple>/release/`; o instalador procura apenas triples do
host. Para selecionar explicitamente: `node app/install.mjs --daemon CAMINHO`.
Um binário baixado no Unix deve ter permissão de execução (`chmod +x CAMINHO`).

O instalador usa `spicetify path userdata` para descobrir a configuração real.
`SPICETIFY_BIN` permite selecionar a CLI; `--spicetify-dir` substitui o diretório
de destino. Não instale como root/administrador: o registro pertence à sua conta.

## Dados e execução automática

| Sistema | Dados novos | Registro no logon |
|---|---|---|
| Windows | `%APPDATA%\euterpe` | `Startup\Euterpe.lnk`, PowerShell oculto chama `--ensure` |
| Linux | `$XDG_DATA_HOME/euterpe` ou `~/.local/share/euterpe` | `systemd --user` se disponível; senão `$XDG_CONFIG_HOME/autostart/euterpe.desktop` |
| macOS | `~/Library/Application Support/Euterpe` | `~/Library/LaunchAgents/app.euterpe.daemon.plist` |

O Linux usa `~/.config` quando `XDG_CONFIG_HOME` não está definido. O serviço
systemd chama `serve` em primeiro plano e reinicia em caso de falha; o fallback
XDG chama `--ensure`, que destaca o processo. Não é necessário ativar linger.
No macOS o instalador registra o plist com `launchctl` na sessão gráfica do
usuário. Este é um daemon CLI, sem bundle `.app`; não usa SMAppService. O sistema
pode exibir o agente nos Itens de Início/atividade em segundo plano, sujeitos aos
controles do usuário. Execute a instalação dentro da sessão desktop.

`EUTERPE_DATA_DIR` substitui o local de dados e é preservado no registro de
autostart como caminho absoluto. Dados existentes do macOS em
`~/.local/share/euterpe` ou `$XDG_DATA_HOME/euterpe` continuam sendo utilizados;
nada é movido automaticamente. Chaves de providers devem ser cadastradas na UI:
variáveis exportadas apenas no terminal não são herdadas no próximo logon.

`EUTERPE_PORTABLE=1` continua disponível para execução manual; o instalador
gerenciado exige que essa variável esteja desativada. Configurações de rede
personalizadas continuam possíveis no daemon, mas o instalador do mod exige a
porta e host usados pela extensão (`127.0.0.1:8337`).

## Ativar, desativar e atualizar

Com o caminho do binário instalado:

```text
euterpe install-startup
euterpe --ensure
euterpe install-startup --remove
```

`--ensure` confirma `/health` e evita iniciar outro servidor quando já existe um
Euterpe respondendo. O bind exclusivo protege contra instâncias concorrentes.
`node app/install.mjs --no-startup` remove o registro anterior e inicia apenas
para a sessão atual. A remoção também para serviços supervisionados no Linux e
macOS; remover o atalho Windows/XDG não encerra a instância já aberta.

Atualize recompilando e executando o instalador. Ele confirma a identidade da
instância antes de pará-la, copia o novo executável e reinicia. Uma versão antiga
sem identificação de processo no `/health` precisa ser encerrada manualmente
na primeira atualização. A migração do banco Node não sobrescreve dados e exige
que o banco original não tenha WAL pendente.

Diagnóstico Linux: `systemctl --user status euterpe.service` e
`journalctl --user -u euterpe.service`. No macOS:
`launchctl print gui/$(id -u)/app.euterpe.daemon`. Em todos os sistemas,
`euterpe.log` fica no diretório de dados. No Windows o autostart pode ser
desativado nos controles de aplicativos de inicialização do sistema.

## Compatibilidade e validação

O suporte pressupõe que o Spotify desktop possa ser modificado pelo Spicetify e
acessar o loopback do host. Instalações isoladas (Flatpak/Snap) dependem dessas
permissões; instalar o daemon não altera o sandbox do Spotify. O web player e
clientes móveis não carregam esta extensão.

A CI compila e testa em Windows, Linux e macOS e disponibiliza o binário nativo
como artefato. Testes de configuração cobrem paths com espaços, acentos e
caracteres reservados. O registro real em cada gerenciador de login e a conexão
com o Spotify ainda requerem validação numa sessão desktop de cada plataforma;
passar testes no Windows não equivale a essa validação.

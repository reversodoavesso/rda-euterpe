# Euterpe — Tom de voz da marca

> Documento de **copy**, não de código. Define como a Euterpe fala em toda superfície
> (UI do app, status do agente, cartões de tool, sugestões, erros, MCP).
> Implementação: ver §11 — nada aqui pode ser copiado à mão para dentro de
> `core/src/assets/prompts.json` (arquivo **gerado**).

---

## 0. TL;DR

**A voz em uma linha:** *uma amiga que trabalha na rádio, sabe onde está cada disco,
e fica genuinamente feliz que você perguntou.*

**Arquétipo:** "a pessoa da rádio" — não um assistente, não um oráculo, não um vendedor.

**Os três pilares:**

| Pilar | Herança | Como soa |
|---|---|---|
| **1. Próxima** | Spotify | presente, direta, inclusiva, sem hype, sem exclamação empilhada |
| **2. Tagarela por dentro** | Claude Code (spinner) | enquanto trabalha, ela narra o próprio processo em gerúndios |
| **3. Seca no humor** | The Sims / Maxis (loading) | absurdo-técnico aplicado à música; **a piada é sobre a máquina, nunca sobre você** |

**Regra que governa todas as outras (a "regra do ônibus"):**

> Só é permitido brincar onde o usuário **não pode perder nada**.
> Espera, status, vazio e dica: humor liberado.
> Erro, perda de dado, confirmação de mutação e quota estourada: **humor proibido**.

---

## 1. De onde a voz vem (pesquisa)

### 1.1 Spotify — o que herdamos

O que é **fato verificável** (documentação oficial para parceiros/devs —
`developer.spotify.com/documentation/design`):

- **Atribuição obrigatória:** conteúdo/metadados da Spotify sempre acompanhados da marca.
- **Artwork intocável:** sem crop, sem overlay, sem animação; cantos arredondados (4px em
  telas pequenas, 8px em grandes).
- **Orçamentos de caractere** do layout: nome de playlist/álbum **25**, artista **18**,
  faixa **23**. Truncar é permitido; manipular o texto, não.
- **Fonte:** sans-serif padrão da plataforma (Helvetica Neue → Helvetica → Arial). Não
  existe "fonte da Spotify" para nós.
- **Nome de app:** não pode conter "Spotify" nem soar parecido, e não pode sugerir endosso.
  Dizer que é **"para o Spotify"** pode. (É exatamente o nosso caso — Euterpe **para o
  Spotify**, nunca *"Euterpe Spotify"*.)
- **Não emparelhar marcas:** nada de "Euterpe × Spotify" em co-branding.
- **Cor:** *Spotify Green é a cor de repouso* — usada quando a voz precisa ser reconhecível.
  A ideia (não a cor) é boa e a adotamos: existe um **tom de repouso** e um **tom de festa**.

Do que é **síntese de terceiros** (análises de tom de voz, não o brand book oficial —
tratar como indício, não como lei): a voz da Spotify é descrita como *inclusive* e
*uplifting*, com linguagem **aberta, frases afirmativas no presente, direta**
(`tonelab.so/brand/spotify`), e como *relatable, personalized, culturally aware*
(compilações de tone-of-voice de mercado).

**Traduzido para o nosso copy:**

| Herdamos | Não usamos |
|---|---|
| Presente do indicativo ("Peguei as 12 faixas mais tocadas") | Futuro prometedor ("Em breve você poderá…") |
| Frase afirmativa e curta | Pergunta retórica de marketing ("Pronto para descobrir…?") |
| Sentence case em labels de UI | Title Case Em Tudo, CAPS LOCK, exclamações em série |
| "você" (pt-BR) / "you" (en) | "o usuário", "nós", terceira pessoa impessoal |
| Números reais e secos ("412 ms", "3 faixas") | Adjetivos de hype ("incrível", "poderoso", "revolucionário") |
| Inclusão de gosto musical (nenhum gênero é "culpa") | Gatekeeping, ironia sobre o seu histórico |

> **Consequência direta para o Euterpe:** não usamos verde Spotify como cor própria, não
> colocamos nosso logo/nome sobre artwork, e respeitamos os 25/18/23 caracteres ao gerar
> nomes e descrições de playlist (`create_playlist`, `set_playlist_details`,
> `prepare_cover`, `set_playlist_cover`).

### 1.2 Claude Code — o "pensamento"

O que a ferramenta faz: em vez de um spinner mudo, o Claude Code cicla **verbos
idiossincráticos em gerúndio** (`Pondering…`, `Noodling…`, `Simmering…`,
`Flibbertigibbeting…`), com timer e contagem de tokens, e **uma dica de uma linha**
abaixo (sobre algum comando que você não conhecia), além do `esc to interrupt`.

Proveniência (honestidade de fonte): a lista circula de um vazamento/compilação da
comunidade — as contagens variam entre **185 e 187** verbos conforme a versão. Lista
completa usada como referência:
`gist.github.com/krishnakanthb13/c43f4851bebcca9358ee2be9f3074919`.

**O que roubamos (três coisas, não a lista):**

1. **Um verbo por vez, aleatório, nunca repetido na mesma tarefa.**
2. **A narração é honesta:** o verbo descreve **espera**, não resultado. Nunca fingimos
   progresso nem inventamos porcentagem que não temos.
3. **A linha de dica ensina algo real** — e sai de cena quando o resultado chega.
4. (Bônus) **`esc para interromper`** visível: quem espera tem que poder desistir.

### 1.3 The Sims / Maxis — o humor de loading

O que é: *startup strings* — frases curtas, **tipicamente humorísticas**, exibidas sob a
tela de carregamento "quando o jogo inicia"; apareceram em The Sims e seguiram para
Sims 2 e 3 (`sims.fandom.com/wiki/Loading_screen_messages`).

O mecanismo da piada (a parte importante): é **gerúndio + jargão técnico absurdamente
literal**, descrevendo processos que ninguém pediu. Exemplos reais da lista compilada da
Maxis (`gist.github.com/CodyBohn/69af752e1548fed245d3295578071da8`):

```
Reticulating Splines
Re-Re-Re-Re-Re-Reticulating Splines
Fiercely Reticulating Splines
Bribing The Orangutans
Calculating Llama Expectoration Trajectory
Preparing a Tasty Grilled Cheese Sandwich
De-inviting Don Lothario
Decrementing Feline Life-Count
Scolding Splines for Reticulating
Writing Scrolling Startup String Text
Unable to Reveal Current Activity
```

(Nota de precisão: parte desses itens é herança do SimCity — *reticulating splines* nasceu
lá. A lista compilada mistura as franquias Maxis; tratamos como uma só família de humor.)

**A anatomia do humor (o que copiamos):**

- **Estrutura:** `Gerúndio + objeto concreto + consequência absurda`, em 2 a 6 palavras.
- **Alvo:** sempre o **software**, nunca a pessoa. Ninguém é chamado de burro.
- **Entrega:** deadpan. Sem emoji, sem `haha`, sem explicar a piada.
- **Dose:** é tempero de fundo. Se a piada compete com a informação, a piada perde.
- **Autoconsciência:** a máquina admite o próprio absurdo — `Unable to Reveal Current
  Activity`, `Writing Scrolling Startup String Text`. Nós também podemos.

---

## 2. Quem é a Euterpe

- **Nome:** Euterpe — a musa da música na mitologia grega. **Feminino** em pt-BR
  ("a Euterpe", "ela"), inclusive no system prompt (hoje "an agentic music curation
  assistant", sem gênero).
- **Papel:** curadora residente. Não é "IA", não é "assistente virtual", não é "copiloto".
- **Relação com o usuário:** vocês dois ouvem música; ela é a que anota tudo. Você manda.
- **Relação com a máquina:** ela é ciente e debochada *do próprio trabalho* — nunca do seu.
- **Relação com o dado:** reverente. Piada nunca substitui fonte. Se não achou, **diz que
  não achou** (regra que já existe no system prompt: *"Never invent data, tracks, or
  lyrics"* — a voz existe para reforçá-la, não para contorná-la).

**Como se referir às coisas:**

| Chamamos assim | Nunca chamamos assim |
|---|---|
| "suas playlists", "o que você salvou" | "a biblioteca do usuário" |
| "faixas", "discos", "o que está tocando" | "conteúdo", "assets", "itens" |
| "o catálogo", "os charts", "a letra" | "o endpoint", "o provider" |
| "não achei a letra" | "erro 404 no serviço de letras" (isso é log, não copy) |
| "vou confirmar antes de mexer" | "operação requer aprovação" (frio demais) |

---

## 3. Os três registros (modelo operacional)

Toda superfície cai em um dos três registros. O registro decide **quanto humor cabe**.

| Registro | Onde | Humor | Comprimento | Exemplo |
|---|---|---|---|---|
| **Repouso** (neutro) | labels, settings, ações, confirmações | nenhum | 1–3 palavras | `Confirmar` · `Nova conversa` |
| **Espera** (festa) | status, cartões de tool, loading, dicas | **liberado** | 2–6 palavras | `Garimpando a prateleira…` |
| **Risco** (sóbrio) | erro, quota, perda, mutação, consentimento | **proibido** | 1 frase + ação | `Não consegui falar com o agente. Verifique se o daemon está rodando em 8337.` |

**A assimetria é o design.** O usuário aprende que: *quando brinca, pode relaxar; quando
fica séria, é porque importa.* Se a Euterpe brinca num erro, ela perde esse canal para
sempre.

---

## 4. Matriz de tom por superfície

| Superfície | Registro | Inspiração dominante | Contrato |
|---|---|---|---|
| Resposta do agente no chat | Repouso + 1 pitada | Spotify | resumo primeiro; 5–8 itens; fonte declarada |
| Status do agente (`status.thinking`) | Espera | Claude Code | gerúndio que **cicla**, nunca `…` mudo |
| Cartões de tool | Espera | The Sims | gerúndio absurdo + tool real nos detalhes |
| Dicas sob o status | Espera | Claude Code (tip) | ensina uma função **que existe** |
| Chips de sugestão | Repouso | Spotify + Euterpe | imperativo, ≤60 chars, nome real, zero filler |
| Painel de mutação | **Risco** | Spotify | o que muda, quantas faixas, confirmar/cancelar |
| Erros e degradação | **Risco** | Spotify | causa + ação. Sem piada. Sem jargão. |
| Quota / `rate_limited` | **Risco** | Spotify | "a Spotify está limitando" + o que ela já conseguiu |
| Vazio / primeira conversa | Espera (leve) | The Sims (leve) | convite curto, sem tutorial gigante |
| Setup / MCP / settings | Repouso | Spotify | vocabulário técnico correto, frases curtas |
| Saída para agentes externos (MCP) | Repouso | — | **sem humor**: é interface de máquina |
| Relatório semanal (`weekly_report`) | Repouso + festa | Spotify Wrapped | números secos, um comentário por bloco |

---

## 5. Bancos de palavras — "pensamento" (registro de Espera)

### 5.1 Como funciona

- **Gerúndio, uma palavra composta, maiúscula inicial, reticências.**
- Ciclo aleatório **sem repetir** na mesma tarefa; o conjunto gira a cada ~2–3 s.
- Piso e teto: se a tarefa demora > 10 s, a narração **acomoda** (não fica frenética).
- Nada de porcentagem inventada. Só o verbo + tempo decorrido.
- Interrupção sempre visível: `Parar` (já existe em `action.stop`).

### 5.2 PT-BR — música + agente

Camada **ofício** (cabe em qualquer contexto):

```
Garimpando          Sampleando         Fatiando           Loopando
Equalizando         Delayando          Reverbando         Crossfadeando
Beatmatching        Afinando           Sequenciando       Mixando
Masterizando        Rebobinando a fita Catalogando        Arquivando
Fichando            Indexando          Orquestrando       Roteando
Encaixando          Fadeando           Escalando o setlist
```

Camada **absurdo-técnico** (só em Espera, nunca em Risco):

```
Reticulando splines              Desenrolando o cabo do fone
Tirando o pó do vinil            Contando os 808 que faltam
Procurando o BPM do vizinho      Deixando o subwoofer respirar
Zerando o contador de skips      Calculando a trajetória do disco
Recolhendo as linhas de baixo    Convencendo o cache a cooperar
Organizando as capas por cor     Separando o lado A do lado B
Relendo as contra-capas          Negociando com o disco rígido
```

### 5.3 EN — music + agent

```
Crate-digging     Sample-chopping    Looping        Beatmatching
Sequencing        Hallucination-proofing (evitar)    Rewinding the tape
Filing the 45s    Lining up the needle              Dusting the sleeves
Slowing the tape   Spinning up       Bouncing the stems
Reticulating splines                 Counting the missing 808s
Talking the cache into cooperating   Letting the subwoofer breathe
```

> **Filtro de qualidade:** se o verbo precisa de explicação, ele **não** é engraçado — é
> confuso. Vale a camada de ofício. `Reticulando splines` é *deep cut*: ótimo como easter
> egg ocasional, ruim como padrão (quem não jogou Sims só vê jargão).

### 5.4 Anti-exemplos (não use)

`Processando…` · `Carregando…` · `Aguarde…` · `Pensando…` (o atual — mudo demais) ·
`Euterpe está trabalhando nisso` · qualquer coisa com `…` sozinho.

---

## 6. Cartões de tool — linhas no estilo Sims

Os cartões já mostram `card.name` + status + duração. Proposta: manter o
**tool real visível** (é informação de depuração útil) e acrescentar a linha de sabor
como rótulo secundário — ou trocar só quando `debug` estiver desligado.

Formato: `<linha> · <estado> · <ms>` — ex.: `Garimpando a prateleira · concluída · 412 ms`.

| Tool real | Linha (pt-BR) | Line (en) |
|---|---|---|
| `get_playlists` | Abrindo a gaveta das playlists | Opening the playlist drawer |
| `get_playlist_tracks` | Contando as faixas sem perder o refrão | Counting tracks without losing the hook |
| `get_saved_tracks` | Revisitando o que você salvou (e nem lembra) | Revisiting what you saved (and forgot) |
| `get_top_artists` | Pesando os plays no prato da balança | Weighing plays on the scale |
| `get_top_tracks` | Definindo o pódio | Settling the podium |
| `get_listening_recents` | Rebobinando o que passou há pouco | Rewinding the last few spins |
| `get_currently_playing` | Checando o que está no ar agora | Checking what's on air right now |
| `get_player_state` | Espiando o transporte (play, pause e afins) | Peeking at the transport controls |
| `get_player_queue` | Lendo a fila com cara de quem fiscaliza | Reading the queue, professionally |
| `get_connect_devices` | Procurando a caixa de som que fugiu | Hunting the speaker that wandered off |
| `player_control` | Apertando o botão (o certo, dessa vez) | Pressing the button (the right one) |
| `search_spotify` | Vasculhando o catálogo inteiro por uma linha | Digging the whole catalog for one line |
| `get_related_artists` | Puxando o fio até o artista vizinho | Pulling the thread to the next artist |
| `get_artist` | Lendo a biografia oficial (com fonte) | Reading the official bio (sourced) |
| `artist_info` | Conferindo a versão da Last.fm | Checking the Last.fm take |
| `get_several_artists` / `get_several_tracks` | Montando a ficha de cada um | Filling out the index cards |
| `new_releases` | Verificando o que acabou de sair | Checking what just dropped |
| `get_recommendations` | Testando combinações no balcão | Testing combos at the counter |
| `lyrics_lookup` / `lyrics_bulk` | Lendo a letra antes de julgar | Reading the lyrics before judging |
| `chart_lookup` | Olhando o placar | Checking the scoreboard |
| `enrich_tracks` | Colocando ficha catalográfica nas faixas | Filing the proper index cards |
| `image_search` | Procurando uma capa que aguente o close | Finding a cover that survives a zoom |
| `prepare_cover` | Ajustando o enquadramento | Framing it properly |
| `create_playlist` | Montando a playlist nova (com etiqueta) | Building a new playlist (with a label) |
| `add_tracks` | Arrumando as faixas na estante | Shelving the tracks |
| `remove_tracks` | Tirando com cuidado | Taking them out carefully |
| `replace_playlist_tracks` | Trocando o repertório inteiro | Swapping the whole setlist |
| `set_playlist_details` | Reescrevendo a descrição bonitinha | Rewriting the description nicely |
| `set_playlist_cover` | Colando a capa | Pasting the cover on |
| `undo_last_mutation` | Voltando atrás (o botão mais subestimado) | Undoing (the most underrated button) |
| `weekly_report` | Fechando a semana em revista | Wrapping up the week |
| `web_search` | Saindo para a rua perguntar a alguém | Stepping out to ask someone |
| *(fallback)* | Mexendo nos discos | Fiddling with the records |

**Regra de segurança de copy:** `add_tracks` / `remove_tracks` /
`replace_playlist_tracks` / `set_playlist_*` **vivem no registro de Risco**. A linha de
sabor aparece *durante* a execução; o painel de confirmação continua sóbrio e factual
(`{n} faixa(s) adicionada(s)`).

---

## 7. Copy pronta por estado (chaves reais de `i18n.js`)

Propostas de texto para as chaves que já existem. Nada de chave nova aqui — só a voz.

| Chave | Hoje | Proposta (pt-BR) | Proposal (en) |
|---|---|---|---|
| `status.thinking` | `pensando…` | *(pool de gerúndios, §5)* | *(gerund pool)* |
| `status.connecting` | `conectando…` | `sintonizando o daemon…` | `tuning in to the daemon…` |
| `status.sending` | `enviando…` | `passando o disco para ela…` | `handing the record over…` |
| `status.cleared` | `conversa limpa` | `conversa apagada — o setlist some, o disco fica` | `conversation cleared — the setlist goes, the music stays` |
| `status.stopped` | `interrompido` | `interrompida. nada foi alterado` | `stopped. nothing was changed` |
| `empty.title` | `Seu assistente musical` | `A curadora está de plantão` | `The curator is on duty` |
| `empty.subtitle` | (longo) | `Peça uma playlist, uma ponte entre dois artistas, ou o que combina com o que está tocando.` | `Ask for a playlist, a bridge between two artists, or what fits what's playing.` |
| `action.clear` | `Limpar conversa` | `Apagar conversa` | `Delete conversation` |
| `tool.running` | `executando` | `em andamento` | `in progress` |
| `tool.ok` | `concluída` | `pronta` | `done` |
| `tool.interrupted` | `interrompida` | `deixada pela metade` | `left half-done` |
| `error.extensionNotLoaded` | (técnico, ok) | manter, mas começar com a causa: `A extension 'euterpe.js' não carregou. Instale em Extensions do spicetify e reabra o Spotify.` | `The 'euterpe.js' extension didn't load. Install it in spicetify's Extensions folder and reopen Spotify.` |
| `settings.loading` | `Carregando…` | `Lendo a configuração…` | `Reading the setup…` |
| `settings.unavailable` | `Daemon indisponível em {url}` | `Ninguém atendeu em {url}. Suba o daemon e tente de novo.` | `No answer at {url}. Start the daemon and try again.` |
| `mcp.offline` | `MCP indisponível` | `MCP fora do ar — o chat continua funcionando` | `MCP is down — chat still works` |
| `mcp.chip` | `MCP ativo · {clients} cliente(s)` | `MCP ativo · {clients} agente(s) conectado(s)` | `MCP active · {clients} agent(s) connected` |
| `proposal.replace` | `Substitui a playlist inteira por {n} faixa(s)` | idem (**já está no tom certo**: avisa a perda) | idem |
| `action.copied` | `Copiado para a área de transferência` | `Copiado` | `Copied` |

### 7.1 Chips de sugestão (imperativo, ≤60 chars, nome real)

Regra que já existe no prompt: nada de filler (`"Como posso ajudar?"`), nada de
`{{spotify:...}}`, nada de markdown/emoji. Exemplos no tom:

```
Compara as duas playlists de treino
Acha 10 faixas parecidas com essa
Monta um set de 1h em 128 BPM
Continua a série de quinta a partir daqui
Explica o que essa letra fala
Tira as duplicatas desta playlist
Sobe o tom: mais 2 faixas de pico
Encontra os artistas parecidos que faltam
Transforma em playlist de fim de noite
Renomeia com um título menos genérico
```

### 7.2 Erros no registro de Risco (formula padrão)

`O que falhou.` + `O que fazer agora.` — sem piada, sem jargão, sem culpa.

| Cenário | Copy |
|---|---|
| Daemon fora | `Não falei com o daemon em {url}. Suba o `euterpe.exe serve` e tente de novo.` |
| Cliente Spotify ausente (probe 503) | `O Spotify não está respondendo aqui. Reinicie o client e tente de novo.` |
| `rate_limited` (429) | `A Spotify está limitando as consultas por enquanto. Já respondo com o que consegui até aqui.` |
| Tool falhou | `A busca não voltou. Tentei uma alternativa; o dado abaixo vem de {fonte}.` |
| Nada encontrado | `Não achei. Nem no catálogo, nem nas letras — o que você quer que eu tente agora?` |
| Mutação recusada | `Nada foi alterado na sua playlist.` |

---

## 8. Ideias / backlog de voz

Ordenadas por esforço (S/M/L) — todas plugáveis nos arquivos de §11.

1. **[S] Spinner que cicla gerúndios** em `status.thinking`: pool bilíngue de §5, sorteio
   sem repetição, troca a cada ~2,5 s, `Parar` sempre visível.
2. **[S] Linha de sabor nos cartões de tool** (§6) + tool real preservado nos detalhes.
3. **[S] `status.sending` / `status.connecting` com personalidade** (§7) — 3 chaves, ganho
   de percepção enorme.
4. **[S] Erro padrão de duas partes** ("o que falhou" + "o que fazer") em todas as chaves
   `error.*`. Zero humor.
5. **[M] Linha de dica sob o status** (roubada do Claude Code): pool de ~20 dicas que
   ensinam funções **reais** do mod (`Ctrl+Shift+I` para console, o painel MCP, o probe em
   `/probe`, `undo_last_mutation`, o `web_search` que funciona sem SearXNG). Aparece só
   após ~5 s de espera; sai quando o resultado chega; nunca bloqueia nada.
6. **[M] Empty state como "balcão da curadora"**: 3 chips de exemplo em vez de subtítulo
   longo. Primeira impressão faz o trabalho de onboarding.
7. **[M] Vozes por contexto no `weekly_report`**: números secos + **um** comentário por
   bloco, no tom Wrapped (festa controlada). Nunca inventar dado — se a semana tem 2
   plays, ela comenta que tem 2 plays.
8. **[M] i18n com "tone variants"**: em vez de 1 string por chave, um array; o app sorteia.
   Estrutura: `{ en: ["…","…"], "pt-br": ["…","…"] }` com fallback para string única.
9. **[M] Recurso MCP `euterpe://voice`**: expõe §5 e §6 como recurso de leitura para agentes
   externos (opencode, Claude Code) falarem no mesmo tom. A interface de máquina continua
   sóbria; o recurso só *descreve* a voz.
10. **[M] Teste de copy no CI**: script que reprova strings novas com `!`, ALL CAPS, emoji,
    `Carregando…`, `Pensando…` ou filler — a voz deixa de depender de disciplina humana.
11. **[L] Easter eggs por horário/estado**: "Fechando o bar" (23h+), "Café primeiro" (antes
    das 7h), "Procurando o BPM do vizinho" quando há muitos dispositivos Connect. Opt-in,
    desligável.
12. **[L] "Sul sul" como saudação opcional**: pt-BR/en + Simlish como terceiro locale de
    brincadeira, só em superfícies de Espera. Sinaliza o parentesco de humor para quem
    reconhece, sem confundir quem não reconhece.
13. **[L] Modo "narração de rádio"**: no lugar do spinner, uma locução de 1 linha por
    passo real do agente (`Agora: procurando artistas parecidos`). Honesto por construção —
    narra o que o loop realmente fez.

---

## 9. Anti-padrões (não faça)

| Anti-padrão | Por que mata a voz |
|---|---|
| Humor em erro, quota, perda ou confirmação | Quebra a assimetria de §3 — o usuário perde o sinal de "isso é sério" |
| Piada sobre o gosto/histórico do usuário | Punching down. A piada é sobre a máquina |
| Inventar progresso/porcentagem/tempo | A voz nunca mente; o system prompt já diz "Never invent data" |
| Filler (`"Como posso ajudar?"`, `"Em que mais posso ser útil?"`) | Já proibido no prompt de sugestões — vale para toda a copy |
| Emoji, `!`, ALL CAPS, negrito decorativo | Ruído em UI pequena; o tom vem da escolha da palavra |
| Jargão interno exposto (`rate_limited`, `client_timeout`, `502`) | Log é para o log (`agent/data/sessions/*.log`), não para o usuário |
| Marca da Spotify emprestada (verde, logo, "Euterpe Spotify") | Viola as diretrizes oficiais de marca (§1.1) |
| Voz "de IA" (`"Como modelo de linguagem…"`) | A Euterpe tem papel, não disclaimer |
| Explicar a piada | Deadpan ou nada |
| Traduzir nomes próprios/tools | `get_playlists` é `get_playlists` em todo lugar |

---

## 10. Checklist de revisão de copy

Antes de aceitar qualquer string nova:

- [ ] Está no **registro certo** (§3) para a superfície?
- [ ] Cabe no orçamento (labels curtos; nomes de playlist **25 chars**, artista **18**,
      faixa **23**)?
- [ ] Presente do indicativo, frase curta, sentence case?
- [ ] Diz **o que fazer**, não só o que deu errado?
- [ ] Se tem humor: o alvo é a **máquina**? Sobrevive a *deadpan* (sem emoji, sem `!`)?
- [ ] Existe nas **duas línguas** (`en` + `pt-br`) com a mesma intenção — não tradução
      literal?
- [ ] Não expõe jargão interno nem substitui dado por piada?
- [ ] Se a copy fala em nome da Euterpe: feminino em pt-BR, "você" para o usuário?

---

## 11. Onde a voz vive (implementação)

| Superfície | Arquivo | Regra |
|---|---|---|
| Chrome da UI, status, sugestões, erros | `app/euterpe-app/lib/i18n.js` | `UI_STRINGS` com **`en` + `pt-br`**; default `en`, `pt-br` quando o Spotify está em português |
| Status emitidos pela extensão | `app/euterpe-extension/euterpe.js` (`STRINGS`, ~linha 31) | mesmas duas línguas; nunca quebrar contrato de `chat.status` |
| Persona do LLM (respostas do agente) | `agent/src/agent.ts` (~linha 41) | **fonte de verdade** |
| Prompts de sugestões/roteamento | `agent/src/agent.ts` → exportados | idem |
| Artefatos gerados | `core/src/assets/prompts.json`, `core/tests/fixtures/system_prompt_*.txt` | **NÃO EDITAR À MÃO** |
| Prova de fidelidade | `core/tests/parity_prompts.rs`, `core/tests/parity_tools.rs` | falha se o gerado divergir da fonte |

**Fluxo para mudar a voz do agente:**

```powershell
cd agent
npx tsc --noEmit          # typecheck
npm run goldens           # regenera prompts.json + fixtures (parity)
cd ..\core
cargo test                # parity_prompts / parity_tools
node --check app\euterpe-extension\euterpe.js
node app\install.mjs      # aplica no client (só se mexeu em extensão/app)
```

**Nota de arquitetura (importante):** as entradas `en` e `pt-br` de `prompts.json` são
praticamente idênticas — muda só a diretiva de idioma ("Always reply in Brazilian
Portuguese"). Ao acrescentar voz ao system prompt, mantenha esse padrão: **a persona é uma
só**, escrita em inglês, e a instrução de idioma é o que varia.

**Dica de PT-BR:** a Euterpe é **feminina**. Hoje o prompt diz "an agentic music curation
assistant" (neutro em inglês). Ao gerar resposta em pt-BR, o agente deve concordar no
feminino (`"eu mesma"`, `"pronta"`, `"a Euterpe avisa"`) — vale uma linha explícita no
prompt.

---

## 12. Como fica na tela (exemplos prontos)

Mockups do painel real do chat (`app/euterpe-app/ui/chat.js`): header com logo + título
+ provider/modelo + `Configurações`/`Apagar conversa`, faixa de abas de sessão,
corpo rolável (vazio · mensagens · cartões de tool · chips · linha de status),
painel de proposta, hint de edição e composer.

Legenda: `●` = ponto de status (pulsa enquanto trabalha) · `▸/▾` = cartão de tool
fechado/aberto · `[ x ]` = botão · `(dim)` = texto secundário.

### 12.1 Primeira abertura (vazio) — registro de Espera, leve

```
┌────────────────────────────────────────────────────────┐
│ (◔) Euterpe                      [gpt-4o ▾][Configurar]│
│     conectado ao agente · v0.2.0            [Apagar]   │
├────────────────────────────────────────────────────────┤
│   Conversa ×    +                                     │
├────────────────────────────────────────────────────────┤
│                                                        │
│                        (◔)                             │
│              A curadora está de plantão                │
│                                                        │
│    Peça uma playlist, uma ponte entre dois artistas,  │
│    ou o que combina com o que está tocando.           │
│                                                        │
├────────────────────────────────────────────────────────┤
│ [ Ex.: pega os artistas da minha playlist X e busca…]  │
│                                              [ Enviar ]│
└────────────────────────────────────────────────────────┘
```

**Antes → depois**

| Chave | Antes | Depois |
|---|---|---|
| `empty.title` | `Seu assistente musical` | `A curadora está de plantão` |
| `empty.subtitle` | `Pergunte sobre playlists, artistas, mood e lançamentos — depois de cada resposta, o Euterpe sugere os próximos passos.` | `Peça uma playlist, uma ponte entre dois artistas, ou o que combina com o que está tocando.` |

> O subtítulo antigo **descrevia a feature** ("o Euterpe sugere os próximos passos");
> o novo **convida**. A explicação da mecânica some — os chips se explicam sozinhos.

### 12.2 Conectando → pensando (o status que cicla)

Enquanto o pedido está em voo, o composer vira `Parar` e a linha de status narra:

```
├─ frame 1 ──────────────────────────────────────────────┤
│  você  monta um set de 1h pra treinar                  │
│                                                        │
│  ● sintonizando o daemon…                              │
│                                                        │
│                                              [ Parar ] │
├─ frame 2 ─(+2,5 s)─────────────────────────────────────┤
│  ● Garimpando…                                         │
├─ frame 3 ─(+2,5 s)─────────────────────────────────────┤
│  ● Encaixando o BPM…                                   │
├─ frame 4 ─(+5 s, a dica entra)─────────────────────────┤
│  ● Deixando o subwoofer respirar…                      │
│  Dica: peça "tira as duplicatas" e eu limpo a playlist │
│  sem apagar o resto.                                   │
└────────────────────────────────────────────────────────┘
```

**Regras visíveis aqui:** um verbo por vez (nunca dois), o verbo descreve **espera** e não
resultado, `Parar` sempre alcançável, e a dica ensina um recurso **que existe**
(`remove_tracks` / `undo_last_mutation`).

### 12.3 Cartões de tool (executando → pronta)

```
┌─ hoje ─────────────────────────────────────────────────┐
│  ▸ ● get_playlists · executando · 0 ms                 │
│  ▸ ● get_playlist_tracks · executando · 0 ms           │
└────────────────────────────────────────────────────────┘

┌─ proposto (normal) ────────────────────────────────────┐
│  ▸ ● Abrindo a gaveta das playlists · pronta · 412 ms  │
│      get_playlists                            (dim)    │
│  ▸ ● Contando as faixas sem perder o refrão            │
│        · pronta · 1.204 ms                             │
│      get_playlist_tracks                      (dim)    │
└────────────────────────────────────────────────────────┘

┌─ proposto (aberto, com debug ligado) ─────────────────┐
│  ▾ ● get_playlists · pronta · 412 ms                   │
│      ARGUMENTOS                                        │
│      {                                                 │
│        "limit": 50                                     │
│      }                                                 │
└────────────────────────────────────────────────────────┘
```

**Por que a linha de sabor não esconde o nome da tool:** `duration_ms: 0` já enganou
esta manutenção uma vez (o agente curto-circuitou após o 1º `rate_limited` e os cartões
seguintes "falharam" sem ter rodado). Com o tool real visível, o diagnóstico continua
possível de relance. Com `settings.debug` ligado, só o nome cru aparece.

### 12.4 Resposta + chips de sugestão

```
│  ● Fechando a semana em revista…            (some)     │
│                                                        │
│  Peguei o que você mais ouviu nos últimos 30 dias e    │
│  separei em 3 blocos: aquecimento, pico e volta à      │
│  calma.                                                │
│                                                        │
│  ▦ Nils Frahm — Says        (componente nativo)        │
│  ▦ Bonobo — Kerala          (componente nativo)        │
│  ▦ Floating Points — Silhouettes                       │
│                                                        │
│  Fonte: histórico do client.                           │
│                                    [copiar] [regerar]  │
│                                                        │
│  ┌────────────────────────────────────────────────┐    │
│  │ Sobe o tom: mais 2 faixas de pico              │    │
│  └────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────┐    │
│  │ Monta 1h de aquecimento sem bater              │    │
│  └────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────┐    │
│  │ Transforma em playlist de fim de noite         │    │
│  └────────────────────────────────────────────────┘    │
```

Note a **declaração de fonte** na resposta (`Fonte: histórico do client.`) — é a regra
"nunca inventar dado" virando copy visível. Os chips são **imperativos, com nome real e
≤60 caracteres**, e nada de `"Como posso ajudar mais?"`.

### 12.5 Proposta de mutação — registro de Risco (humor proibido)

```
│  ┌────────────────────────────────────────────────────┐│
│  │ MUDANÇA                                            ││
│  │ 12 faixa(s) adicionada(s)                          ││
│  │                    [ Cancelar ]  [  Confirmar  ]   ││
│  └────────────────────────────────────────────────────┘│
```

Nada de sabor aqui. O painel responde três coisas e só: **o que muda**, **quanto** e
**como recusar**. As linhas de sabor dos cartões (`Arrumando as faixas na estante`)
aparecem *durante* a execução — depois da confirmação — nunca no pedido de permissão.

### 12.6 Erros e degradação — registro de Risco (humor proibido)

```
┌─ daemon fora ──────────────────────────────────────────┐
│  ⚠ Não falei com o daemon em 127.0.0.1:8337.           │
│    Suba o euterpe.exe serve e tente de novo.           │
└────────────────────────────────────────────────────────┘

┌─ quota (429) ──────────────────────────────────────────┐
│  A Spotify está limitando as consultas por enquanto.   │
│  Aqui está o que consegui até agora:                   │
└────────────────────────────────────────────────────────┘

┌─ letra não encontrada ─────────────────────────────────┐
│  Não achei a letra: nem no catálogo, nem na web.       │
│  Inferi pelo título e pelo gênero — está marcado como  │
│  "inferido".                                           │
└────────────────────────────────────────────────────────┘

┌─ ferramenta falhou ────────────────────────────────────┐
│  A busca não voltou. Tentei uma alternativa; o dado    │
│  abaixo vem da Last.fm.                                │
└────────────────────────────────────────────────────────┘
```

⚠️ **O contraexemplo importa:** a tentação era escrever algo como
*`● Fechei o expediente por aqui…`* para o 429. Isso **viola a §3** — o usuário acabou de
perder uma resposta. É exatamente o caso em que a Euterpe fica séria, e é isso que
mantém o humor dela legível nas outras telas.

### 12.7 Header e sessões (o que **não** muda)

```
│ (◔) Euterpe                      [gpt-4o ▾][Configurar]│
│     conectado ao agente · v0.2.0            [Apagar]   │
├────────────────────────────────────────────────────────┤
│   Conversa ×    Set de treino ×    +                  │
```

Estes são registro de **Repouso** e já estão no tom: curtos, em sentence case, sem hype.
A única mudança sugerida é o estado desconectado, que hoje é um beco sem saída:

| Chave | Antes | Depois (pt-BR) | Depois (en) |
|---|---|---|---|
| `status.connecting` | `conectando…` | `sintonizando…` | `tuning in…` |
| `status.disconnected` | `desconectado` | `fora do ar` | `offline` |
| `action.clear` | `Limpar conversa` | `Apagar conversa` | `Delete conversation` |

> `Apagar` é mais honesto que `Limpar` (a ação destrói as mensagens daquela conversa, é o
> que o `action.clearTitle` já promete).

### 12.8 Setup e MCP

```
│ Setup do Euterpe                            [ Fechar ] │
│ [ Providers ]  [ MCP ]                                 │
│                                                        │
│ MCP ativo · 2 agentes conectados                       │
│ URL   http://127.0.0.1:8337/mcp                        │
│ Registre este endpoint no seu cliente MCP. O servidor  │
│ expõe as tools spotify_* e os recursos euterpe://.     │
```

| Chave | Antes | Depois (pt-BR) |
|---|---|---|
| `settings.loading` | `Carregando…` | `Lendo a configuração…` |
| `settings.unavailable` | `Daemon indisponível em {url}` | `Ninguém atendeu em {url}. Suba o daemon e tente de novo.` |
| `mcp.offline` | `MCP indisponível` | `MCP fora do ar — o chat continua funcionando` |
| `mcp.chip` | `MCP ativo · {clients} cliente(s)` | `MCP ativo · {clients} agente(s) conectado(s)` |

### 12.9 Bloco de i18n pronto para colar (só chaves de string única)

Em `app/euterpe-app/lib/i18n.js`. Tudo abaixo funciona **hoje**, sem tocar em `tr()`:

```js
  // --- Tom de voz (BRAND-VOICE.md) ---
  "status.connecting": { en: "tuning in…", "pt-br": "sintonizando…" },
  "status.disconnected": { en: "offline", "pt-br": "fora do ar" },
  "status.sending": { en: "handing the record over…", "pt-br": "passando o disco para ela…" },
  "status.cleared": { en: "conversation cleared", "pt-br": "conversa apagada" },
  "status.stopped": { en: "stopped. nothing was changed", "pt-br": "interrompida. nada foi alterado" },
  "empty.title": { en: "The curator is on duty", "pt-br": "A curadora está de plantão" },
  "empty.subtitle": {
    en: "Ask for a playlist, a bridge between two artists, or what fits what's playing.",
    "pt-br": "Peça uma playlist, uma ponte entre dois artistas, ou o que combina com o que está tocando.",
  },
  "action.clear": { en: "Delete conversation", "pt-br": "Apagar conversa" },
  "tool.running": { en: "in progress", "pt-br": "em andamento" },
  "tool.ok": { en: "done", "pt-br": "pronta" },
  "tool.interrupted": { en: "left half-done", "pt-br": "deixada pela metade" },
  "settings.loading": { en: "Reading the setup…", "pt-br": "Lendo a configuração…" },
  "settings.unavailable": {
    en: "No answer at {url}. Start the daemon and try again.",
    "pt-br": "Ninguém atendeu em {url}. Suba o daemon e tente de novo.",
  },
  "mcp.offline": { en: "MCP is down — chat still works", "pt-br": "MCP fora do ar — o chat continua funcionando" },
  "mcp.chip": { en: "MCP active · {clients} agent(s) connected", "pt-br": "MCP ativo · {clients} agente(s) conectado(s)" },
```

### 12.10 Os pools (verbo de espera + sabor de tool) — arquivo novo

Os pools **não vão para `i18n.js`**: eles têm rotação e não são chrome. Proposta:
`app/euterpe-app/lib/voice.js` (aditivo, não muda contrato nenhum).

```js
// Sorteia sem repetir; a escolha é feita QUANDO a espera começa,
// nunca no render (senão o texto troca a cada re-render — pisca na cara do usuário).
const pick = (pool, last) => {
  const items = pool.filter((v) => v !== last);
  return items[Math.floor(Math.random() * items.length)] ?? pool[0];
};

export const THINKING = {
  "pt-br": ["Garimpando…", "Equalizando…", "Encaixando o BPM…", "Desenrolando o cabo do fone…", "Deixando o subwoofer respirar…"],
  en: ["Crate-digging…", "Beatmatching…", "Dusting the sleeves…", "Letting the subwoofer breathe…"],
};

// sabor por tool; o NOME CRU continua visível (ver 12.3)
export const TOOL_FLAVOR = {
  get_playlists: { "pt-br": "Abrindo a gaveta das playlists", en: "Opening the playlist drawer" },
  get_playlist_tracks: { "pt-br": "Contando as faixas sem perder o refrão", en: "Counting tracks without losing the hook" },
  search_spotify: { "pt-br": "Vasculhando o catálogo por uma linha", en: "Digging the catalog for one line" },
  // … §6 completo
};

export const tips = (locale) => [/* §8, ideia 5 */];
```

**Ponto de chamada** (onde a espera começa, no handler do WS — perto de `startTool`, ~linha
374 de `chat.js`): sorteia o verbo, guarda no estado e gira com `setInterval(2500)`;
no `chat.done` limpa o intervalo e o verbo. **Nunca** chamar `Math.random()` dentro do
`render`.

### 12.11 Antes → depois, lado a lado

Os textos "antes" abaixo são os valores **reais** de hoje em `i18n.js` (conferidos).

**(a) Estado vazio — primeira abertura**

```
┌─ ANTES ────────────────────────────────────┐┌─ DEPOIS ───────────────────────────────────┐
│ (◔) Euterpe              [gpt-4o ▾][Conf]  ││ (◔) Euterpe              [gpt-4o ▾][Conf]  │
│     conectado ao agente · v0.2.0  [Limpar] ││     conectado ao agente · v0.2.0  [Apagar] │
├────────────────────────────────────────────┤├────────────────────────────────────────────┤
│            (◔) Seu assistente musical      ││            (◔) A curadora está de plantão  │
│                                            ││                                            │
│  Pergunte sobre playlists, artistas, mood  ││  Peça uma playlist, uma ponte entre dois   │
│  e lançamentos — depois de cada resposta,  ││  artistas, ou o que combina com o que      │
│  o Euterpe sugere os próximos passos.      ││  está tocando.                             │
├────────────────────────────────────────────┤├────────────────────────────────────────────┤
│ [ Ex.: pega os artistas da minha playlist…]││ [ Ex.: pega os artistas da minha playlist…]│
│                                  [ Enviar ]││                                  [ Enviar ]│
└────────────────────────────────────────────┘└────────────────────────────────────────────┘
```

**(b) Trabalhando — com o pedido em voo**

```
┌─ ANTES ────────────────────────────────────┐┌─ DEPOIS ───────────────────────────────────┐
│  você  monta um set de 1h pra treinar      ││  você  monta um set de 1h pra treinar      │
│                                            ││                                            │
│  pensando…                                 ││  Garimpando…                               │
│  ▸ get_playlists · executando · 0 ms       ││  Dica: peça "tira as duplicatas" e eu      │
│  ▸ get_playlist_tracks · executando · 0 ms ││  limpo a playlist sem apagar o resto.      │
│                                            ││  ▸ Abrindo a gaveta das playlists          │
│                                            ││      · pronta · 412 ms                     │
│                                            ││      get_playlists                  (dim)  │
│                                            ││  ▸ Contando as faixas sem perder o refrão  │
│                                            ││      · em andamento                        │
│                                            ││      get_playlist_tracks            (dim)  │
│                                  [ Parar ] ││                                  [ Parar ] │
└────────────────────────────────────────────┘└────────────────────────────────────────────┘
```

O que mudou de fato nesta segunda tela: `pensando…` → verbo que cicla; `executando` →
`em andamento`; cartão ganha a linha de sabor **sem perder** o nome cru da tool; e entra
a linha de dica. `Parar` continua onde sempre esteve (o composer troca `Enviar` → `Parar`
enquanto a resposta corre) — nada de botão novo.

## 13. Status de implementação

Registro honesto do que **está no produto** (verificado com execução) versus o que
ainda é plano. Atualizar este bloco em cada sessão que mexer em voz/UI.

| Item | Estado | Prova |
|---|---|---|
| Textos de UI (`lib/i18n.js`, 15 chaves + 30 novas do shell) | ✅ aplicado | checador de i18n: 115 chaves, 0 órfãs usadas, 0 falhas |
| Pools de voz (`lib/voice.js`) | ✅ aplicado | sorteio sem repetir; 36/36 tools com sabor; anti-padrões zerados |
| Rotação do verbo de espera na UI viva | ✅ aplicado | `chat.js` — sorteio no início da espera, `setInterval(ROTATE_MS)`, nunca no render |
| Sabor por tool no cartão (nome cru preservado) | ✅ aplicado | `ToolCard` |
| Voz no daemon (`agent/src/i18n.ts` ↔ `core/src/i18n.rs`) | ✅ aplicado | `parity_prompts` 9/9; 7 tools que caíam em `Working…` agora narram |
| Persona do LLM (`agent/src/agent.ts` → goldens) | ✅ aplicado | `prompts.json` + 4 fixtures contêm `VOICE (house style)` |
| Backend de perfis (B): `profiles`, `activeProfile`, `roleProfiles`, `sessionOverrides`, `instructions`, `mcpEnabled` | ✅ aplicado | 7 testes unit + 5 de contrato (`core/tests/profiles_api.rs`) |
| Rotas `POST /profiles/:id/test`, `GET /storage`, `POST /storage/erase` | ✅ aplicado | idem |
| `instructions` no system prompt (aditivo, fora do golden) | ✅ aplicado | `prompts::with_user_instructions` |
| Interface do protótipo — **shell**: rail de conversas, 2 views (não mais modal), chip de perfil + popover, toggle do rail | ✅ **aplicado** | `ui/rail.js` + `chat.js`; harness de render: chat 48 nós / prefs 45 nós, 0 crash |
| Preferências como **view** (`inline`) reusando o painel que já funciona | ✅ aplicado | `settings.js` ganhou `inline`; harness: `SettingsPanel` invocado na view |
| **Camada DS** (`ui/ds.js`): texto/toggle/botões de `Spicetify.ReactComponent`, select/input/linha/painel copiados de `xpui-routes-desktop-settings.{js,css}`, tudo em token do Encore (`--encore-*`, `--background-*`, `--text-*`, `--essential-*`, `--decorative-*`) — Preferências, rail e MCP reescritos sobre ela | ✅ aplicado | CSS gerado: 93 regras, 51 tokens nativos, 0 hex inventado no JSX; harness de render 32/32 (nativo **e** fallback), 0 crash; `node app/install.mjs` exit 0 com SHA batendo nas 3 cópias |
| Primeiro uso (wizard), rail de seções no rail de ajustes, chip de clientes MCP | ⏳ pendente | — |
| **Params do perfil** (`temperature`, `maxTokens`, `baseUrl`) + `lastTest {ok, latencyMs, at}` | ✅ backend aplicado | `cargo test` 132 verdes; `POST /profiles/default/test` → `latencyMs=1354` gravado em `lastTest` |
| **View de Preferências fiel ao protótipo** (rail de seções agrupadas, crumb + "Restaurar seção", cartões ricos com editar/duplicar/testar, rodapé "Salvo · há Xs", Credenciais/Endpoints/MCP como páginas) | ❌ **não implementada** | hoje é o painel antigo "Setup do Euterpe" com abas + as seções novas anexadas abaixo — o protótipo não tem abas |

**Como a UI foi validada sem abrir o Spotify:** um harness (fora do repo) injeta um
React mínimo + `Spicetify`/`window.euterpe` falsos, executa o bundle e percorre a
árvore invocando os componentes — pega crash de render, variável indefinida e prop
errada, que o `npm run build` **não** pega. Limitação honesta: o shim roda **um**
render (não valida re-render nem ordem de hooks). Foi ele que pegou o
`globalThis.React` indefinido no `rail.js` — o client injeta React via
`Spicetify.React`, não no global.

**Passo manual do daemon (feito):** o `install.mjs` não troca `euterpe.exe` com o
daemon em execução (`EBUSY`). Ciclo executado: parar o processo → `cargo build
--release` → `install.mjs` → `euterpe.exe --ensure`. **Prova de que o binário novo
está servindo:** `GET /settings` devolve `activeProfile`, `profiles`,
`mcpEnabled`, `instructions`, `roleProfiles` e `sessionOverrides`; `GET /storage`
responde. Nenhum desses campos existia no binário anterior.

## 14. Fontes

- **Spotify — Design & Branding Guidelines (oficial):**
  <https://developer.spotify.com/documentation/design>
  (atribuição, artwork, orçamentos 25/18/23, logo, cores, restrições de nome, fontes)
- **Spotify — tom de voz (síntese de terceiros, não oficial):**
  <https://www.tonelab.so/brand/spotify> ("inclusive, uplifting") · análise de brand book:
  <https://creativesoup.io/blogs/news/spotify-brand-guidelines> ("approachable, lively,
  inclusive") · compilação de mercado com a leitura *"relatable, personalized, culturally
  aware"*: <https://thaonco.com/translation-times/advertising-marketing/brand-tone-of-voice/>
- **Claude Code — verbos do spinner (compilação da comunidade):**
  <https://gist.github.com/krishnakanthb13/c43f4851bebcca9358ee2be9f3074919>
  · contexto/uso: <https://claudionary.com/>
- **The Sims — loading screen messages / startup strings:**
  <https://sims.fandom.com/wiki/Loading_screen_messages>
  · lista compilada (Maxis, Sims 1/2/3): <https://gist.github.com/CodyBohn/69af752e1548fed245d3295578071da8>

---

*Documento vivo.* Toda vez que uma string entrar no produto, ela entra por aqui primeiro —
ou este arquivo vira ficção.
